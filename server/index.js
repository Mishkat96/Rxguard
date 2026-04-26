import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import Anthropic from '@anthropic-ai/sdk'
import fetch from 'node-fetch'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Prevent any unhandled error from crashing the server and resetting client connections
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err)
})

const app = express()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

app.use(cors())
app.use(express.json({ limit: '10mb' }))

const brandsDb = JSON.parse(readFileSync(join(__dirname, '../data/bd_brands.json'), 'utf8')).brands

// ── Brand resolution ──────────────────────────────────────────────
// Strip "Tab.", "Cap.", "Syr." etc. and trailing strength from a drug name
function cleanDrugName(raw) {
  return raw
    .replace(/^\s*(tab\.?|cap\.?|syr\.?|susp\.?|inj\.?|oint\.?|drops?\.?|soln?\.?)\s*/i, '')
    .replace(/\s+\d+(\.\d+)?\s*(mg|ml|mcg|g|iu|%|unit)s?\s*$/i, '')
    .trim()
}

function resolveBrand(brandName) {
  const raw = brandName.toLowerCase().trim()
  const cleaned = cleanDrugName(raw)

  // 1. Exact match on raw input
  if (brandsDb[raw]) return { generic: brandsDb[raw], found: true }

  // 2. Exact match after stripping form prefix and strength
  if (cleaned !== raw && brandsDb[cleaned]) return { generic: brandsDb[cleaned], found: true }

  // 3. The cleaned name IS already a generic — pass it through as-is
  //    (e.g. "Tab Paracetamol" → "paracetamol", "Cap Ciprofloxacin" → "ciprofloxacin")
  //    Mark found:true so it goes through RxNorm rather than being flagged unverified
  if (cleaned !== raw && cleaned.length > 2) {
    return { generic: cleaned, found: true, resolvedAsGeneric: true }
  }

  // 4. Not found — return raw cleaned name, let RxNorm try
  return { generic: cleaned || brandName, found: false }
}

// ── Fetch + parse JSON with AbortController timeout ──────────────
// AbortController properly cancels the underlying TCP request on timeout,
// preventing dangling rejected promises that crash Node on unhandled rejection.
function fetchJSON(url, ms = 6000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return fetch(url, { signal: controller.signal })
    .then(r => r.json())
    .finally(() => clearTimeout(timer))
}

// ── RxNorm lookup ─────────────────────────────────────────────────
async function getRxCUI(genericName) {
  try {
    const url = `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(genericName)}&search=1`
    const data = await fetchJSON(url, 5000)
    const ids = data?.idGroup?.rxnormId
    if (ids?.length) return { rxcui: ids[0], found: true }
  } catch (_) {}
  return { rxcui: null, found: false }
}

// ── OpenFDA label warnings ────────────────────────────────────────
async function getOpenFDAWarnings(genericName) {
  try {
    const baseName = genericName.split('+')[0].trim()
    // Fire all three field strategies in parallel — take the first that returns a label
    const queries = [
      `openfda.generic_name:"${encodeURIComponent(baseName)}"`,
      `openfda.substance_name:"${encodeURIComponent(baseName)}"`,
      `generic_name:"${encodeURIComponent(baseName)}"`,
    ].map(q =>
      fetchJSON(`https://api.fda.gov/drug/label.json?search=${q}&limit=1`, 6000)
        .then(d => d?.results?.[0] || null)
        .catch(() => null)
    )
    const results = await Promise.all(queries)
    const label = results.find(Boolean)
    if (!label) return { warnings: [], setid: null, genericName }
    // spl_set_id is the canonical DailyMed identifier (stable across label versions)
    const setid = label.openfda?.spl_set_id?.[0] || label.id || null
    const warnings = []
    for (const field of ['drug_interactions', 'warnings', 'boxed_warning', 'contraindications', 'warnings_and_cautions']) {
      if (label[field]?.[0]) warnings.push(label[field][0].slice(0, 600))
    }
    return { warnings, setid, genericName }
  } catch (_) { return { warnings: [], setid: null, genericName } }
}

// ── NLM interaction check ─────────────────────────────────────────
async function getNLMInteractions(rxcuis) {
  if (rxcuis.length < 2) return []
  try {
    const url = `https://rxnav.nlm.nih.gov/REST/interaction/list.json?rxcuis=${rxcuis.join('+')}`
    const data = await fetchJSON(url, 8000)
    const flags = []
    for (const group of data?.fullInteractionTypeGroup ?? []) {
      for (const itype of group?.fullInteractionType ?? []) {
        for (const pair of itype?.interactionPair ?? []) {
          const sev = pair.severity?.toLowerCase()
          if (!['high', 'moderate', 'n/a'].includes(sev)) continue
          const drugs = pair.interactionConcept?.map(c => c.minConcept?.name) ?? []
          flags.push({
            drugs,
            severity: sev === 'high' || sev === 'n/a' ? 'major' : 'moderate',
            description: pair.description ?? '',
            source: 'NLM Drug Interaction API'
          })
        }
      }
    }
    return flags
  } catch (_) { return [] }
}

// ── Prompts ───────────────────────────────────────────────────────
const VISION_PROMPT = `You are RxGuard's vision extraction engine. Read this handwritten prescription and extract all medicines.

The prescription may be in Bengali, English, or mixed. Common shorthand: bd=twice daily, tds=three times daily, od=once daily, stat=immediately, Tab=tablet, Cap=capsule.

Output ONLY a valid JSON array. No explanation, no markdown.

Each item:
{"brand_name":"exact name as written","strength":"e.g. 500mg","frequency":"e.g. bd","duration":"e.g. 5 days","confidence":{"brand_name":0.0,"strength":0.0,"frequency":0.0,"duration":0.0}}

Confidence: 0.9-1.0=certain, 0.7-0.89=fairly confident, <0.7=uncertain. Use "UNREADABLE" if you cannot read a field. Never silently drop a drug.`

const SAFETY_SYSTEM = `You are RxGuard, a prescription safety flagger. Detect dangers and return patients to their doctor. Nothing else.

ABSOLUTE RULES:
1. Never recommend alternative medications.
2. Never suggest dose changes.
3. Never tell patient to stop/skip/change medication.
4. Never diagnose or explain what medicines do.
5. recommendation field MUST always be exactly: "Return to your doctor before taking these medicines."
6. Every flag MUST have a real, verifiable citation. Only cite these verified sources:
   - "NLM Drug Interaction API (ONCHigh dataset)" — the NLM interaction API uses ONCHigh (curated by clinical experts at NLM) as its primary dataset. Use this citation when interaction data came from the NLM API.
   - "FDA Drug Label: [drug name] via OpenFDA" — when warning came from OpenFDA label data provided
   - "FDA Drug Label: [drug name]" — for contraindications in FDA-approved prescribing information
   - "WHO Essential Medicines List, 23rd Edition (2023)" — for WHO-listed contraindications
   - "FDA Pregnancy Category D/X" — for established pregnancy contraindications
7. If you cannot cite one of the above for a specific flag, do NOT raise that flag.
8. Never fabricate citations.
9. Output only valid JSON. Never prose.`

function buildCheckPrompt(generics, patient, openfdaData, nlmResults, unverified, session_id) {
  return `DRUGS ON PRESCRIPTION (generic names): ${JSON.stringify(generics)}

PATIENT PROFILE: ${JSON.stringify(patient)}

API DATA RETRIEVED (primary evidence sources):
OpenFDA label warnings per drug:
${JSON.stringify(openfdaData, null, 2)}

NLM drug interaction pairs detected:
${JSON.stringify(nlmResults, null, 2)}

Drugs not found in RxNorm (South Asian market brands not in US databases):
${JSON.stringify(unverified)}

INSTRUCTIONS:
1. Use API data as primary evidence. Extract contraindication text directly from OpenFDA labels.
2. Cite OpenFDA label text as "FDA Drug Label: [drug name]" — this is real FDA-approved prescribing information.
3. For drugs not in any API: list in uncertain_drugs, do not flag interactions for them.
4. Flag all NLM major and moderate severity pairs found.
5. Check patient's other_medications against prescription drugs.
6. If heart_problems=yes: NSAIDs (diclofenac, ibuprofen, etoricoxib, naproxen, aspirin high-dose) increase cardiovascular risk and worsen heart failure — flag if present, cite "FDA Drug Label: [drug name] — cardiovascular risk warning".
7. If blood_condition=yes: flag any drug known to cause hemolytic anemia in G6PD deficiency (nitrofurantoin, primaquine, dapsone, rasburicase, sulfonamides) — cite "FDA Drug Label: [drug name] — G6PD deficiency contraindication".
8. If diabetes=yes: flag fluoroquinolones (ciprofloxacin, levofloxacin, moxifloxacin) which cause blood sugar dysregulation; flag corticosteroids (prednisolone, dexamethasone) which raise blood glucose significantly — cite "FDA Drug Label: [drug name] — blood glucose warning".

SESSION ID: ${session_id}

Output ONLY valid JSON:
{
  "status": "clean" | "flagged" | "uncertain",
  "flags": [
    {
      "type": "drug_interaction" | "patient_risk" | "prescription_error",
      "drugs_involved": ["generic_name_1", "generic_name_2"],
      "risk_description": "Plain language, under 30 words, no jargon.",
      "severity": "major" | "moderate",
      "source_name": "OpenFDA" | "NLM" | "WHO EML" | "FDA",
      "source_citation": "Specific real citation",
      "recommendation": "Return to your doctor before taking these medicines."
    }
  ],
  "extraction_confidence": 0.9,
  "uncertain_drugs": [],
  "session_id": "${session_id}"
}

If no flags: status="clean", flags=[].
If some drugs unverifiable but others checked: still flag the verified ones, list unverifiable in uncertain_drugs.
Only set status="uncertain" if ALL drugs are unverifiable.`
}

// ── JSON parser ───────────────────────────────────────────────────
function parseJSON(text) {
  let clean = text.trim()
  if (clean.startsWith('```')) {
    clean = clean.replace(/^```json?\n?/, '').replace(/\n?```$/, '')
  }
  return JSON.parse(clean)
}

// ── SSE helper ────────────────────────────────────────────────────
function sseWrite(res, event, data) {
  if (!res.writableEnded) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
}

// ── Routes ────────────────────────────────────────────────────────

app.get('/api/health', (_, res) => res.json({ status: 'ok' }))

// Stage 1: Vision extraction
app.post('/api/extract', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ detail: 'No file uploaded' })

  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
  if (!allowed.includes(req.file.mimetype)) {
    return res.status(400).json({ detail: 'Image must be JPEG, PNG, WEBP, or GIF' })
  }

  const b64 = req.file.buffer.toString('base64')
  const mediaType = req.file.mimetype

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
          { type: 'text', text: VISION_PROMPT }
        ]
      }]
    })
    const drugs = parseJSON(response.content[0].text)
    res.json({ session_id: uuidv4(), drugs })
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(500).json({ detail: 'Could not parse prescription. Try a clearer photo.' })
    }
    res.status(500).json({ detail: err.message })
  }
})

// Stages 2–4: Safety check with SSE progress streaming
app.post('/api/check-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  // Disable socket timeout — SSE connections stay open for up to 90s while APIs run.
  // Without this, Node/OS can kill the silent socket mid-pipeline and cause ECONNRESET.
  try {
    req.socket.setTimeout(0)
    req.socket.setNoDelay(true)
    req.socket.setKeepAlive(true)
  } catch (_) {}

  // Track client disconnect — listen on res, not req.
  // req 'close' fires when the request body is consumed (too early for SSE).
  // res 'close' fires when the actual response connection is gone.
  let clientGone = false
  res.on('close', () => { clientGone = true })

  const finish = () => { if (!res.writableEnded) res.end() }

  // Heartbeat every 15s — keeps Vite proxy and any upstream proxies/firewalls from
  // dropping the connection during silent API wait periods (RxNorm, OpenFDA, Claude).
  // SSE comment lines (starting with ':') are ignored by the client EventSource.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !clientGone) res.write(':ping\n\n')
  }, 15000)

  // Hard 90-second total timeout
  const hardTimeout = setTimeout(() => {
    if (!clientGone) sseWrite(res, 'error', { message: 'Safety check timed out. External medical databases may be slow. Please try again.' })
    finish()
  }, 90000)

  const { drugs, patient, session_id } = req.body

  try {
    // Stage 2: brand → generic
    if (clientGone) { clearTimeout(hardTimeout); return finish() }
    sseWrite(res, 'progress', { step: 1, total: 4, message: 'Translating brand names to generic names...' })
    const resolved = drugs.map(d => {
      const r = resolveBrand(d.brand_name)
      return { ...d, generic: r.generic, found_in_db: r.found }
    })
    const generics = resolved.map(d => d.generic)
    const unverified = resolved.filter(d => !d.found_in_db).map(d => d.brand_name)

    // Stage 3: RxNorm
    if (clientGone) { clearTimeout(hardTimeout); return finish() }
    sseWrite(res, 'progress', { step: 2, total: 4, message: 'Looking up drugs in RxNorm international database...' })
    const rxcuiResults = await Promise.all(generics.map(getRxCUI))
    const rxcuis = rxcuiResults.filter(r => r.found && r.rxcui).map(r => r.rxcui)
    const trulyUnverified = resolved
      .filter((d, i) => !d.found_in_db && !rxcuiResults[i].found)
      .map(d => d.brand_name)

    // Stage 4a: APIs in parallel
    if (clientGone) { clearTimeout(hardTimeout); return finish() }
    sseWrite(res, 'progress', { step: 3, total: 4, message: 'Checking OpenFDA drug labels and NLM interaction database...' })
    const [openfdaResults, nlmResults] = await Promise.all([
      Promise.all(generics.map(getOpenFDAWarnings)),
      getNLMInteractions(rxcuis)
    ])
    const setidMap = {}
    openfdaResults.forEach(r => { if (r.setid) setidMap[r.genericName] = r.setid })
    const openfdaData = Object.fromEntries(generics.map((g, i) => [g, openfdaResults[i].warnings]))

    // Stage 4b: Claude reasoning
    if (clientGone) { clearTimeout(hardTimeout); return finish() }
    sseWrite(res, 'progress', { step: 4, total: 4, message: 'Running AI safety analysis with Claude Opus 4.7...' })
    const userMsg = buildCheckPrompt(generics, patient, openfdaData, nlmResults, trulyUnverified, session_id)

    const claudeRes = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 3000,
      system: SAFETY_SYSTEM,
      messages: [{ role: 'user', content: userMsg }]
    })

    let result
    try {
      result = parseJSON(claudeRes.content[0].text)
    } catch (_) {
      result = {
        status: 'uncertain',
        flags: [],
        uncertainty_reason: 'AI analysis returned an unexpected response. Please consult your doctor.',
        extraction_confidence: 0,
        uncertain_drugs: unverified,
        session_id
      }
    }
    result.resolved_drugs = resolved
    result.setid_map = setidMap

    clearTimeout(hardTimeout)
    if (!clientGone) sseWrite(res, 'result', result)
  } catch (err) {
    clearTimeout(hardTimeout)
    if (!clientGone) sseWrite(res, 'error', { message: err.message || 'Unexpected error during safety check.' })
  } finally {
    clearTimeout(hardTimeout)
    clearInterval(heartbeat)
    finish()
  }
})

// Doctor summary data endpoint (returns structured JSON for frontend rendering)
app.post('/api/doctor-summary-from-result', (req, res) => {
  const { flags_result, patient_profile } = req.body
  const flags = flags_result?.flags ?? []
  const resolved = flags_result?.resolved_drugs ?? []
  const now = new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })

  res.json({
    generated_at: now,
    medicines: resolved.map(d => ({ brand: d.brand_name || d.brand, generic: d.generic, strength: d.strength })),
    patient: patient_profile,
    flags,
    flag_count: flags.length,
    status: flags_result?.status,
    uncertain_drugs: flags_result?.uncertain_drugs ?? []
  })
})

const PORT = process.env.PORT || 8000
app.listen(PORT, () => console.log(`RxGuard backend running on http://localhost:${PORT}`))
