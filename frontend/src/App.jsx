import { useState, useRef, useCallback } from 'react'

// ── Source URL generator — deterministic, no AI hallucination risk ─
// Priority: direct DailyMed setid link (from actual OpenFDA response) > known FDA pages > fallback
const NSAID_GENERICS = new Set([
  'diclofenac', 'diclofenac sodium', 'ibuprofen', 'naproxen', 'etoricoxib',
  'celecoxib', 'meloxicam', 'indomethacin', 'ketoprofen', 'piroxicam', 'aspirin'
])

function getSourceUrl(flag, setidMap = {}) {
  const src = flag.source_name || ''
  const drugs = flag.drugs_involved || []

  if (src.includes('WHO')) {
    return {
      url: 'https://www.who.int/publications/i/item/WHO-MHP-HPS-EML-2023.02',
      label: 'WHO Essential Medicines List, 23rd Edition (2023)'
    }
  }

  // NLM interaction flags — link to the NLM Drug Interaction API (the actual data source)
  if (src.includes('NLM')) {
    const rxcuiQuery = drugs.map(d => encodeURIComponent(d)).join('+')
    return {
      url: `https://mor.nlm.nih.gov/RxNav/search?searchBy=Interaction&searchTerm=${encodeURIComponent(drugs[0] || '')}`,
      label: 'NLM RxNav — Drug Interaction Data Source'
    }
  }

  // Use real setid from OpenFDA response for a direct, working DailyMed link
  for (const drug of drugs) {
    const setid = setidMap[drug]
    if (setid) {
      return {
        url: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${setid}`,
        label: 'NLM DailyMed — View Full FDA Drug Label'
      }
    }
  }

  // Fallback: DailyMed search using just the base drug name (first word, no salt suffix)
  const baseDrug = drugs[0]?.split(/[\s+]/)[0] || ''
  if (baseDrug) {
    return {
      url: `https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=${encodeURIComponent(baseDrug)}`,
      label: 'NLM DailyMed — FDA Drug Label'
    }
  }

  return null
}

function SourceLink({ flag, setidMap }) {
  const ref = getSourceUrl(flag, setidMap)
  if (!ref) return null
  return (
    <a
      href={ref.url}
      target="_blank"
      rel="noopener noreferrer"
      className="source-link"
    >
      {ref.label} ↗
    </a>
  )
}

const API = '/api'

const S = {
  LANDING: 'landing',
  DISCLAIMER: 'disclaimer',
  PHOTO: 'photo',
  EXTRACTING: 'extracting',
  CONFIRM: 'confirm',
  QUESTIONS: 'questions',
  PROCESSING: 'processing',
  RESULT: 'result',
  DOCTOR_SUMMARY: 'doctor_summary',
  END: 'end',
}

const QUESTIONS = [
  {
    id: 'age',
    text: 'How old are you?',
    type: 'age_input',
  },
  {
    id: 'pregnant',
    text: 'Are you pregnant or breastfeeding?',
    options: [
      { label: 'Pregnant', value: 'pregnant' },
      { label: 'Breastfeeding', value: 'breastfeeding' },
      { label: 'Not applicable', value: 'no' },
    ],
  },
  {
    id: 'conditions',
    text: 'Do you have any of the following conditions your doctor has told you about?',
    hint: 'Select all that apply.',
    type: 'multi_select',
    options: [
      { label: 'Diabetes', value: 'diabetes' },
      { label: 'Kidney problems', value: 'kidney' },
      { label: 'Liver problems', value: 'liver' },
      { label: 'Heart problems or high blood pressure', value: 'heart' },
      { label: 'A blood condition (G6PD deficiency, thalassemia, or anemia)', value: 'blood' },
      { label: 'None of the above', value: 'none', exclusive: true },
      { label: "I don't know", value: 'unknown', exclusive: true },
    ],
  },
  {
    id: 'allergies',
    text: 'Do you have any known medicine allergies?',
    type: 'text_or_no',
    placeholder: 'e.g. penicillin, sulfa drugs, aspirin',
  },
  {
    id: 'other_medications',
    text: 'Are you currently taking any other medicine not on this prescription?',
    type: 'text_or_no',
    placeholder: 'e.g. warfarin, metformin, insulin',
  },
]

function confDot(v) {
  const cls = v >= 0.9 ? 'conf-green' : v >= 0.7 ? 'conf-yellow' : 'conf-red'
  return <span className={`conf-dot ${cls}`} />
}

function confLabel(v) {
  if (v >= 0.9) return 'High confidence'
  if (v >= 0.7) return 'Medium confidence — please verify'
  return 'Low confidence — please correct'
}

function Spinner({ size = 18 }) {
  return (
    <span
      className="spinner"
      style={{ width: size, height: size }}
      aria-label="Loading"
    />
  )
}

function BackButton({ onClick }) {
  return (
    <button className="back-btn" onClick={onClick} aria-label="Go back">
      ← Back
    </button>
  )
}

function ProgressSteps({ steps }) {
  return (
    <div className="progress-list">
      {steps.map((step, i) => {
        const isActive = i === steps.length - 1 && !step.done
        const isDone = step.done
        return (
          <div key={i} className={`progress-item ${isDone ? 'done' : ''} ${isActive ? 'active' : ''}`}>
            <span className="progress-icon">
              {isDone ? '✓' : isActive ? <Spinner size={14} /> : '○'}
            </span>
            <span className="progress-text">{step.message}</span>
          </div>
        )
      })}
    </div>
  )
}

// ── Doctor Summary Screen ────────────────────────────────────────
function DoctorSummaryScreen({ summaryData, setidMap = {}, onBack }) {
  if (!summaryData) return null
  const { generated_at, medicines, patient, flags, uncertain_drugs, status } = summaryData
  // generic → brand lookup for showing names patients recognise
  const g2b = {}
  medicines.forEach(m => { if (m.generic && m.brand) g2b[m.generic.toLowerCase()] = m.brand })

  return (
    <div className="screen doctor-screen">
      <div className="doctor-toolbar no-print">
        <button className="back-btn" onClick={onBack}>← Back to results</button>
        <button className="btn btn-primary btn-sm" onClick={() => window.print()}>
          Print / Save PDF
        </button>
      </div>

      <div className="doctor-content" id="print-area">
        <div className="doctor-header">
          <div className="doctor-logo">💊 RxGuard</div>
          <h1>Clinical Flag Summary</h1>
          <p className="doctor-meta">Generated: {generated_at}</p>
          <div className="doctor-disclaimer-badge">
            Flagging tool only — not a medical report. Clinical judgment rests with the physician.
          </div>
        </div>

        <section className="doctor-section">
          <h2>Medicines Reviewed</h2>
          <table className="doctor-table">
            <thead>
              <tr><th>Brand (as prescribed)</th><th>Generic name</th><th>Strength</th></tr>
            </thead>
            <tbody>
              {medicines.map((m, i) => (
                <tr key={i}>
                  <td>{m.brand}</td>
                  <td>{m.generic}</td>
                  <td>{m.strength || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="doctor-section">
          <h2>Patient Profile</h2>
          <table className="doctor-table">
            <tbody>
              <tr><td>Age</td><td>{patient?.age || '—'}</td></tr>
              <tr><td>Pregnant</td><td>{patient?.pregnant === 'yes' ? 'Yes' : 'No'}</td></tr>
              <tr><td>Breastfeeding</td><td>{patient?.breastfeeding === 'yes' ? 'Yes' : 'No'}</td></tr>
              <tr><td>Diabetes</td><td>{patient?.diabetes === 'yes' ? 'Yes' : patient?.diabetes === 'unknown' ? 'Unknown' : 'No'}</td></tr>
              <tr><td>Kidney problems</td><td>{patient?.kidney_problems === 'yes' ? 'Yes' : patient?.kidney_problems === 'unknown' ? 'Unknown' : 'No'}</td></tr>
              <tr><td>Liver problems</td><td>{patient?.liver_problems === 'yes' ? 'Yes' : patient?.liver_problems === 'unknown' ? 'Unknown' : 'No'}</td></tr>
              <tr><td>Heart problems / hypertension</td><td>{patient?.heart_problems === 'yes' ? 'Yes' : patient?.heart_problems === 'unknown' ? 'Unknown' : 'No'}</td></tr>
              <tr><td>Blood condition (G6PD / thalassemia)</td><td>{patient?.blood_condition === 'yes' ? 'Yes' : patient?.blood_condition === 'unknown' ? 'Unknown' : 'No'}</td></tr>
              <tr><td>Known allergies</td><td>{patient?.allergies?.length ? patient.allergies.join(', ') : 'None reported'}</td></tr>
              <tr><td>Other medications</td><td>{patient?.other_medications?.length ? patient.other_medications.join(', ') : 'None reported'}</td></tr>
            </tbody>
          </table>
        </section>

        <section className="doctor-section">
          <h2>Flags Detected ({flags.length})</h2>
          {flags.length === 0 ? (
            <p className="no-flags-note">No flags detected by RxGuard for this prescription and patient profile.</p>
          ) : (
            flags.map((flag, i) => (
              <div key={i} className={`doctor-flag ${flag.severity}`}>
                <div className="doctor-flag-header">
                  <span className={`sev-badge ${flag.severity}`}>{flag.severity?.toUpperCase()}</span>
                  <span className="flag-type-label">{flag.type?.replace(/_/g, ' ')}</span>
                </div>
                <div className="doctor-flag-drugs">
                  {flag.drugs_involved?.map(g => {
                    const brand = g2b[g?.toLowerCase()]
                    if (!brand) return g
                    if (brand.toLowerCase() !== g?.toLowerCase()) return `${brand} (${g})`
                    return brand
                  }).join(' + ')}
                </div>
                <div className="doctor-flag-risk">{flag.risk_description}</div>
                <div className="doctor-flag-source">
                  <strong>Source:</strong> {flag.source_name} — {flag.source_citation}
                  {' '}<SourceLink flag={flag} setidMap={setidMap} />
                </div>
                <div className="doctor-flag-action">{flag.recommendation}</div>
              </div>
            ))
          )}
        </section>

        {uncertain_drugs?.length > 0 && (
          <section className="doctor-section">
            <h2>Unverified Medicines</h2>
            <p>The following could not be verified in international drug databases and were excluded from the interaction check:</p>
            <ul>
              {uncertain_drugs.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          </section>
        )}

        <div className="doctor-footer">
          <p>Generated by <strong>RxGuard</strong> prescription safety checker.</p>
          <p>This report is a flagging tool only. It does not constitute medical advice. Clinical judgment rests entirely with the physician.</p>
          <p>Data sources: RxNorm (NLM), OpenFDA, NLM Drug Interaction API.</p>
        </div>
      </div>
    </div>
  )
}

// ── Main App ─────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState(S.LANDING)
  const [history, setHistory] = useState([S.LANDING])
  const [sessionId, setSessionId] = useState(null)
  const [drugs, setDrugs] = useState([])
  const [patient, setPatient] = useState({
    age: '', pregnant: 'no', breastfeeding: 'no',
    diabetes: 'no', kidney_problems: 'no', liver_problems: 'no',
    heart_problems: 'no', blood_condition: 'no',
    allergies: [], other_medications: []
  })
  const [questionIdx, setQuestionIdx] = useState(0)
  const [result, setResult] = useState(null)
  const [summaryData, setSummaryData] = useState(null)
  const [extractSteps, setExtractSteps] = useState([])
  const [processingSteps, setProcessingSteps] = useState([])
  const fileRef = useRef()

  const navigate = useCallback((to) => {
    setHistory(prev => [...prev, to])
    setScreen(to)
  }, [])

  const goBack = useCallback(() => {
    setHistory(prev => {
      if (prev.length <= 1) return prev
      const next = prev.slice(0, -1)
      setScreen(next[next.length - 1])
      return next
    })
  }, [])

  const goBackQuestion = useCallback(() => {
    if (questionIdx > 0) {
      setQuestionIdx(i => i - 1)
    } else {
      goBack()
    }
  }, [questionIdx, goBack])

  // ── Photo upload + Stage 1 ──────────────────────────────────────
  async function handlePhotoUpload(e) {
    const file = e.target.files[0]
    if (!file) return
    navigate(S.EXTRACTING)
    setExtractSteps([{ message: 'Reading your prescription with Claude Opus...', done: false }])

    const form = new FormData()
    form.append('file', file)
    try {
      const res = await fetch(`${API}/extract`, { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Extraction failed')

      setSessionId(data.session_id)
      // Strip "Tab.", "Cap.", "Syr." etc. from names as written by Bangladeshi doctors
      const stripForm = name => name?.replace(/^\s*(tab\.?|cap\.?|syr\.?|susp\.?|inj\.?|oint\.?|drops?\.?|soln?\.?)\s*/i, '').trim() || name
      const found = (data.drugs || []).map(d => ({ ...d, brand_name: stripForm(d.brand_name) }))
      const hasLowConf = found.some(d => Object.values(d.confidence || {}).some(c => c < 0.7))

      setExtractSteps([
        { message: 'Reading your prescription with Claude Opus...', done: true },
        {
          message: `Found ${found.length} medicine${found.length !== 1 ? 's' : ''}: ${found.map(d => [d.brand_name, d.strength].filter(Boolean).join(' ')).join(', ')}`,
          done: true
        },
        {
          message: hasLowConf
            ? `Low confidence on ${found.filter(d => Object.values(d.confidence || {}).some(c => c < 0.7)).length} medicine(s) — please confirm below`
            : 'All medicines read with high confidence',
          done: true
        }
      ])
      setDrugs(found.map(d => ({ ...d })))
      setTimeout(() => navigate(S.CONFIRM), 1000)
    } catch (err) {
      setExtractSteps(prev => [
        ...prev.slice(0, -1).map(s => ({ ...s, done: true })),
        { message: `Error: ${err.message}`, done: true, error: true }
      ])
      setTimeout(() => goBack(), 2500)
    }
  }

  function updateDrug(idx, field, value) {
    setDrugs(prev => prev.map((d, i) => i === idx ? { ...d, [field]: value } : d))
  }

  // ── Question answering ──────────────────────────────────────────
  function applyAnswer(qId, value) {
    setPatient(prev => {
      const next = { ...prev }
      if (qId === 'pregnant') {
        next.pregnant = value === 'pregnant' ? 'yes' : 'no'
        next.breastfeeding = value === 'breastfeeding' ? 'yes' : 'no'
      } else if (qId === 'conditions') {
        // value is an array of selected condition values
        const sel = Array.isArray(value) ? value : []
        const unk = sel.includes('unknown')
        next.diabetes        = unk ? 'unknown' : sel.includes('diabetes') ? 'yes' : 'no'
        next.kidney_problems = unk ? 'unknown' : sel.includes('kidney')   ? 'yes' : 'no'
        next.liver_problems  = unk ? 'unknown' : sel.includes('liver')    ? 'yes' : 'no'
        next.heart_problems  = unk ? 'unknown' : sel.includes('heart')    ? 'yes' : 'no'
        next.blood_condition = unk ? 'unknown' : sel.includes('blood')    ? 'yes' : 'no'
      } else if (qId === 'allergies') {
        next.allergies = value ? value.split(',').map(s => s.trim()).filter(Boolean) : []
      } else if (qId === 'other_medications') {
        next.other_medications = value ? value.split(',').map(s => s.trim()).filter(Boolean) : []
      } else {
        next[qId] = value
      }
      return next
    })
  }

  function handleChoice(qId, value) {
    applyAnswer(qId, value)
    advanceQuestion()
  }

  function handleTextAnswer(qId, text, hasItem) {
    applyAnswer(qId, hasItem ? text : '')
    advanceQuestion()
  }

  function advanceQuestion() {
    if (questionIdx < QUESTIONS.length - 1) {
      setQuestionIdx(i => i + 1)
    } else {
      runSafetyCheck()
    }
  }

  // ── Stages 2–4 with SSE streaming ──────────────────────────────
  async function runSafetyCheck() {
    navigate(S.PROCESSING)
    setProcessingSteps([])

    // Frontend safety net — if nothing completes in 2 min, bail out
    const frontendTimeout = setTimeout(() => {
      setResult({
        status: 'uncertain',
        flags: [],
        uncertainty_reason: 'The check is taking too long — medical databases may be slow right now. Please try again in a few minutes, or consult your doctor directly.',
        session_id: sessionId
      })
      navigate(S.RESULT)
    }, 120000)

    const body = {
      drugs: drugs.map(d => ({
        brand_name: d.brand_name,
        strength: d.strength,
        frequency: d.frequency,
        duration: d.duration
      })),
      patient: {
        age: patient.age || 'unknown',
        pregnant: patient.pregnant || 'no',
        breastfeeding: patient.breastfeeding || 'no',
        diabetes: patient.diabetes || 'no',
        kidney_problems: patient.kidney_problems || 'no',
        liver_problems: patient.liver_problems || 'no',
        heart_problems: patient.heart_problems || 'no',
        blood_condition: patient.blood_condition || 'no',
        allergies: patient.allergies || [],
        other_medications: patient.other_medications || []
      },
      session_id: sessionId
    }

    try {
      const res = await fetch(`${API}/check-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })

      if (!res.ok || !res.body) throw new Error('Server error')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop()

        for (const part of parts) {
          const lines = part.split('\n')
          const eventLine = lines.find(l => l.startsWith('event: '))
          const dataLine = lines.find(l => l.startsWith('data: '))
          if (!dataLine) continue

          const event = eventLine?.slice(7).trim() || 'message'
          let data
          try { data = JSON.parse(dataLine.slice(6)) } catch { continue }

          if (event === 'progress') {
            setProcessingSteps(prev => [
              ...prev.map(s => ({ ...s, done: true })),
              { message: data.message, done: false }
            ])
          } else if (event === 'result') {
            clearTimeout(frontendTimeout)
            setProcessingSteps(prev => prev.map(s => ({ ...s, done: true })))
            setResult(data)
            setTimeout(() => navigate(S.RESULT), 400)
          } else if (event === 'error') {
            clearTimeout(frontendTimeout)
            setResult({
              status: 'uncertain',
              flags: [],
              uncertainty_reason: data.message || 'Safety check failed. Please consult your doctor.',
              session_id: sessionId
            })
            setTimeout(() => navigate(S.RESULT), 400)
          }
        }
      }
    } catch (err) {
      clearTimeout(frontendTimeout)
      setResult({
        status: 'uncertain',
        flags: [],
        uncertainty_reason: `Connection error: ${err.message}. Please try again or consult your doctor directly.`,
        session_id: sessionId
      })
      navigate(S.RESULT)
    }
  }

  // ── Doctor summary ──────────────────────────────────────────────
  async function openDoctorSummary() {
    try {
      const res = await fetch(`${API}/doctor-summary-from-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flags_result: result, patient_profile: patient })
      })
      const data = await res.json()
      setSummaryData(data)
      navigate(S.DOCTOR_SUMMARY)
    } catch {
      alert('Could not generate summary. Please try again.')
    }
  }

  function reset() {
    setScreen(S.LANDING)
    setHistory([S.LANDING])
    setSessionId(null)
    setDrugs([])
    setPatient({ age: '', pregnant: 'no', breastfeeding: 'no', diabetes: 'no', kidney_problems: 'no', liver_problems: 'no', heart_problems: 'no', blood_condition: 'no', allergies: [], other_medications: [] })
    setQuestionIdx(0)
    setResult(null)
    setSummaryData(null)
    setExtractSteps([])
    setProcessingSteps([])
  }

  // ── Render ──────────────────────────────────────────────────────

  if (screen === S.DOCTOR_SUMMARY) {
    return <DoctorSummaryScreen summaryData={summaryData} setidMap={result?.setid_map || {}} onBack={goBack} />
  }

  if (screen === S.LANDING) return (
    <div className="screen screen-center">
      <div className="landing-logo">💊</div>
      <h1 className="landing-title">RxGuard</h1>
      <p className="landing-sub">A prescription safety check for patients who have no pharmacist nearby.</p>
      <div className="gap-lg" />
      <button className="btn btn-primary btn-full" onClick={() => navigate(S.DISCLAIMER)}>
        Start safety check
      </button>
      <div className="gap" />
      <button className="btn btn-ghost btn-full" onClick={() => navigate(S.HOW)}>
        How this works
      </button>
      <div className="landing-footer">
      </div>
    </div>
  )

  if (screen === S.HOW) return (
    <div className="screen">
      <BackButton onClick={goBack} />
      <div className="gap" />
      <h2>How RxGuard works</h2>
      <div className="gap" />
      <div className="how-step">
        <div className="how-num">1</div>
        <div><strong>Photograph</strong> your handwritten prescription</div>
      </div>
      <div className="how-step">
        <div className="how-num">2</div>
        <div><strong>Answer 5 quick questions</strong> about yourself</div>
      </div>
      <div className="how-step">
        <div className="how-num">3</div>
        <div><strong>RxGuard checks</strong> for dangerous drug combinations and patient-specific risks against verified clinical databases (RxNorm, OpenFDA, NLM)</div>
      </div>
      <div className="how-step">
        <div className="how-num">4</div>
        <div>If a problem is found, we <strong>flag it with a cited source</strong> and tell you one thing: return to your doctor</div>
      </div>
      <div className="gap" />
      <div className="info-box">
        <p><strong>What RxGuard never does:</strong> recommend medicines, suggest doses, diagnose conditions, or store your data.</p>
      </div>
      <div className="gap-lg" />
      <button className="btn btn-primary btn-full" onClick={() => navigate(S.DISCLAIMER)}>
        Start safety check
      </button>
    </div>
  )

  if (screen === S.DISCLAIMER) return (
    <div className="screen screen-center">
      <BackButton onClick={goBack} />
      <div className="gap" />
      <h2>Before you continue</h2>
      <div className="gap" />
      <div className="disclaimer-box">
        <p>
          RxGuard is a safety flag, not medical advice. It does not replace your doctor or pharmacist.
        </p>
        <p>
          If we find a possible problem, we will ask you to return to your doctor. If we find nothing, that does not mean your prescription is safe — it only means we did not detect a known problem.
        </p>
        <p>
          <strong>Never change your medication based on this app. Only your doctor can do that.</strong>
        </p>
      </div>
      <div className="gap-lg" />
      <button className="btn btn-primary btn-full" onClick={() => navigate(S.PHOTO)}>
        I understand — continue
      </button>
    </div>
  )

  if (screen === S.PHOTO) return (
    <div className="screen screen-center">
      <BackButton onClick={goBack} />
      <div className="gap" />
      <h2>Photograph your prescription</h2>
      <div className="gap-sm" />
      <p className="hint">Place the prescription on a flat surface. Make sure all medicine names are clearly visible.</p>
      <div className="gap" />
      <div className="upload-zone" onClick={() => fileRef.current.click()}>
        <div className="upload-icon">📷</div>
        <p className="upload-label">Tap to take a photo or upload from gallery</p>
        <p className="upload-hint">JPG, PNG or WEBP · Max 10 MB</p>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={handlePhotoUpload}
      />
      <div className="gap" />
      <button className="btn btn-primary btn-full" onClick={() => fileRef.current.click()}>
        Take photo
      </button>
    </div>
  )

  if (screen === S.EXTRACTING) return (
    <div className="screen screen-center">
      <div className="processing-icon"><Spinner size={40} /></div>
      <h2>Reading your prescription</h2>
      <p className="hint">This usually takes 5–10 seconds.</p>
      <div className="gap" />
      <ProgressSteps steps={extractSteps} />
    </div>
  )

  if (screen === S.CONFIRM) return (
    <div className="screen">
      <BackButton onClick={goBack} />
      <div className="gap" />
      <h2>Confirm medicines</h2>
      <p className="hint">Check each medicine. Correct anything that looks wrong before continuing.</p>
      <div className="gap" />
      {drugs.map((drug, i) => {
        const vals = Object.values(drug.confidence || {})
        const minConf = vals.length ? Math.min(...vals) : 1
        return (
          <div key={i} className="confirm-card">
            <div className="conf-row">
              {confDot(minConf)}
              <span className="conf-label">{confLabel(minConf)}</span>
            </div>
            {minConf < 0.7 && (
              <div className="conf-warning">
                We are not sure about this medicine. Please check your prescription and correct if needed.
              </div>
            )}
            <label className="field-label">Medicine name</label>
            <input
              className="field-input"
              type="text"
              value={drug.brand_name}
              onChange={e => updateDrug(i, 'brand_name', e.target.value)}
            />
            <div className="field-row">
              <div className="field-col">
                <label className="field-label">Strength</label>
                <input className="field-input" type="text" value={drug.strength || ''} onChange={e => updateDrug(i, 'strength', e.target.value)} />
              </div>
              <div className="field-col">
                <label className="field-label">Frequency</label>
                <input className="field-input" type="text" value={drug.frequency || ''} onChange={e => updateDrug(i, 'frequency', e.target.value)} />
              </div>
            </div>
            <div className="field-row">
              <div className="field-col">
                <label className="field-label">Duration</label>
                <input className="field-input" type="text" value={drug.duration || ''} onChange={e => updateDrug(i, 'duration', e.target.value)} />
              </div>
            </div>
          </div>
        )
      })}
      <div className="gap" />
      <button className="btn btn-primary btn-full" onClick={() => { setQuestionIdx(0); navigate(S.QUESTIONS) }}>
        These are correct — continue
      </button>
    </div>
  )

  if (screen === S.QUESTIONS) {
    const q = QUESTIONS[questionIdx]
    return (
      <div className="screen">
        <BackButton onClick={goBackQuestion} />
        <div className="gap" />
        <div className="q-progress">
          <div className="q-progress-bar" style={{ width: `${((questionIdx + 1) / QUESTIONS.length) * 100}%` }} />
        </div>
        <div className="gap-sm" />
        <small className="q-counter">Question {questionIdx + 1} of {QUESTIONS.length}</small>
        <div className="gap" />
        <h2>{q.text}</h2>
        <div className="gap" />
        {q.type === 'text_or_no' ? (
          <TextOrNoQuestion key={q.id} q={q} onAnswer={(text, has) => handleTextAnswer(q.id, text, has)} />
        ) : q.type === 'multi_select' ? (
          <MultiSelectQuestion key={q.id} q={q} onAnswer={vals => { applyAnswer(q.id, vals); advanceQuestion() }} />
        ) : q.type === 'age_input' ? (
          <AgeInputQuestion key={q.id} onAnswer={val => { applyAnswer(q.id, val); advanceQuestion() }} />
        ) : (
          q.options.map(opt => (
            <button key={opt.value} className="choice-btn" onClick={() => handleChoice(q.id, opt.value)}>
              {opt.label}
            </button>
          ))
        )}
      </div>
    )
  }

  if (screen === S.PROCESSING) return (
    <div className="screen screen-center">
      <div className="processing-icon"><Spinner size={40} /></div>
      <h2>Running safety check</h2>
      <p className="hint">Checking drug databases and running AI analysis. Please wait.</p>
      <div className="gap" />
      <ProgressSteps steps={processingSteps} />
    </div>
  )

  if (screen === S.RESULT) {
    if (!result) return null
    const { status, flags = [], uncertainty_reason, uncertain_drugs = [] } = result
    // Build generic → brand name lookup so patients see the name they recognise
    const genericToBrand = {}
    ;(result.resolved_drugs || []).forEach(d => {
      if (d.generic && d.brand_name) genericToBrand[d.generic.toLowerCase()] = d.brand_name
    })
    const drugLabel = (generic) => {
      const brand = genericToBrand[generic?.toLowerCase()]
      if (!brand) return generic
      // Different word: show "Ciprocin (ciprofloxacin)"
      if (brand.toLowerCase() !== generic?.toLowerCase()) return `${brand} (${generic})`
      // Same word, different case: show the patient-confirmed casing e.g. "Ciprofloxacin"
      return brand
    }

    if (status === 'clean') return (
      <div className="screen result-screen result-green">
        <div className="result-icon">✓</div>
        <h1 className="result-title">No known problems detected</h1>
        <p className="result-sub">
          We did not find any known dangerous combinations or patient-specific risks in our database.
        </p>
        {uncertain_drugs.length > 0 && (
          <div className="uncertain-note">
            <strong>Note:</strong> {uncertain_drugs.join(', ')} could not be verified in international databases and were excluded from the check.
          </div>
        )}
        <div className="result-disclaimer">
          This is not a medical clearance. Only your doctor can confirm this prescription is right for you. If anything feels wrong, go back to your doctor.
        </div>
        <button className="btn btn-primary btn-full" onClick={() => navigate(S.END)}>
          Done
        </button>
      </div>
    )

    if (status === 'flagged') return (
      <div className="screen result-screen">
        <div className="result-alert">
          <div className="result-alert-icon">⚠️</div>
          <h2 className="result-alert-title">POTENTIAL PROBLEMS FOUND</h2>
          <p className="result-alert-sub">Do not buy these medicines yet. Return to your doctor first.</p>
        </div>

        <div className="flags-list">
          {flags.map((flag, i) => (
            <div key={i} className={`flag-card flag-${flag.severity}`}>
              <div className="flag-badges">
                <span className={`badge sev-${flag.severity}`}>{flag.severity?.toUpperCase()}</span>
                <span className="badge badge-type">{flag.type?.replace(/_/g, ' ')}</span>
              </div>
              <div className="flag-drugs">{flag.drugs_involved?.map(drugLabel).join(' + ')}</div>
              <div className="flag-risk">{flag.risk_description}</div>
              <div className="flag-source">
                <strong>Source:</strong> {flag.source_name} — {flag.source_citation}
              </div>
              <SourceLink flag={flag} setidMap={result?.setid_map || {}} />
              <div className="flag-action">{flag.recommendation}</div>
            </div>
          ))}
        </div>

        {uncertain_drugs.length > 0 && (
          <div className="uncertain-note">
            <strong>Note:</strong> {uncertain_drugs.join(', ')} could not be verified in international databases and were excluded from the check.
          </div>
        )}

        <div className="gap" />
        <button className="btn btn-danger btn-full" onClick={openDoctorSummary}>
          Show this to your doctor →
        </button>
        <div className="gap-sm" />
        <button className="btn btn-ghost btn-full" onClick={() => navigate(S.END)}>
          Done
        </button>
      </div>
    )

    return (
      <div className="screen result-screen result-yellow">
        <div className="result-icon">?</div>
        <h1 className="result-title">Could not complete full check</h1>
        <p className="result-sub">{uncertainty_reason || 'We could not read one or more medicine names clearly enough to complete a safety check.'}</p>
        {uncertain_drugs.length > 0 && (
          <div className="uncertain-note">
            Medicines we could not verify: {uncertain_drugs.join(', ')}
          </div>
        )}
        <div className="result-disclaimer">
          Please return to your doctor and ask them to clarify the prescription, or confirm what the medicines are.
        </div>
        <button className="btn btn-primary btn-full" onClick={() => navigate(S.END)}>
          Done
        </button>
      </div>
    )
  }

  if (screen === S.END) return (
    <div className="screen screen-center">
      <div style={{ fontSize: '3rem', marginBottom: 16 }}>✓</div>
      <h2>Safety check complete</h2>
      <div className="gap" />
      <div className="info-box">
        <p>No data from this session has been saved. Your prescription photo and answers have been cleared.</p>
      </div>
      <div className="gap-lg" />
      <button className="btn btn-primary btn-full" onClick={reset}>
        Start a new check
      </button>
    </div>
  )

  return null
}

// ── Multi-select Question ────────────────────────────────────────
function MultiSelectQuestion({ q, onAnswer }) {
  const [selected, setSelected] = useState([])

  function toggle(value, exclusive) {
    if (exclusive) {
      setSelected(prev => prev.includes(value) ? [] : [value])
    } else {
      setSelected(prev => {
        const withoutExclusive = prev.filter(v => {
          const opt = q.options.find(o => o.value === v)
          return !opt?.exclusive
        })
        return withoutExclusive.includes(value)
          ? withoutExclusive.filter(v => v !== value)
          : [...withoutExclusive, value]
      })
    }
  }

  return (
    <>
      {q.hint && <p className="hint" style={{ marginBottom: 12 }}>{q.hint}</p>}
      {q.options.map(opt => (
        <button
          key={opt.value}
          className={`choice-btn multi-choice ${selected.includes(opt.value) ? 'selected' : ''}`}
          onClick={() => toggle(opt.value, opt.exclusive)}
        >
          <span className="multi-check">{selected.includes(opt.value) ? '✓' : ''}</span>
          {opt.label}
        </button>
      ))}
      <div className="gap" />
      <button
        className="btn btn-primary btn-full"
        disabled={selected.length === 0}
        onClick={() => onAnswer(selected)}
      >
        Continue
      </button>
    </>
  )
}

// ── Text or No Question ──────────────────────────────────────────
function TextOrNoQuestion({ q, onAnswer }) {
  const [hasItem, setHasItem] = useState(null)
  const [text, setText] = useState('')

  if (hasItem === null) return (
    <>
      <button className="choice-btn" onClick={() => setHasItem(true)}>Yes</button>
      <button className="choice-btn" onClick={() => onAnswer('', false)}>No</button>
    </>
  )

  return (
    <>
      <input
        className="field-input"
        type="text"
        placeholder={q.placeholder}
        value={text}
        onChange={e => setText(e.target.value)}
        autoFocus
      />
      <p className="hint" style={{ marginTop: 8 }}>Separate multiple items with a comma.</p>
      <div className="gap" />
      <button className="btn btn-primary btn-full" onClick={() => onAnswer(text, true)}>
        Continue
      </button>
      <div className="gap-sm" />
      <button className="btn btn-ghost btn-full" onClick={() => { setHasItem(null); setText('') }}>
        ← Change answer
      </button>
    </>
  )
}

// ── Age Input Question ───────────────────────────────────────────
function AgeInputQuestion({ onAnswer }) {
  const [age, setAge] = useState('')
  const valid = age.trim() !== '' && Number(age) > 0 && Number(age) < 130

  return (
    <>
      <input
        className="field-input"
        type="number"
        inputMode="numeric"
        placeholder="Enter your age"
        value={age}
        onChange={e => setAge(e.target.value)}
        autoFocus
        min={1}
        max={129}
      />
      <div className="gap" />
      <button
        className="btn btn-primary btn-full"
        disabled={!valid}
        onClick={() => onAnswer(age.trim())}
      >
        Continue
      </button>
    </>
  )
}
