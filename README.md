# RxGuard

> A prescription safety checker for patients in Bangladesh who have no pharmacist nearby.

In Bangladesh, doctors write prescriptions by hand — in Bengali, English, or both. Patients take those prescriptions to a pharmacy and buy whatever is written, with no one checking for dangerous combinations, contraindications, or patient-specific risks. There is no digital safety net.

RxGuard is that safety net.

A patient photographs their handwritten prescription, answers five questions about themselves, and RxGuard checks it against real clinical databases — FDA drug labels, NLM drug interactions, WHO Essential Medicines — and flags anything dangerous. Its only instruction is: **return to your doctor.**

Built for the **Built with Claude** hackathon using Claude Opus 4.7.

---

## How it works

**1. Read** — Claude Opus 4.7 vision reads the handwritten prescription (Bengali, English, or mixed) and extracts each medicine with a confidence score per field. Unreadable fields are flagged honestly, never silently guessed.

**2. Translate** — Brand names (Napa, Seclo, Ciprocin) are resolved to generic names using a curated Bangladesh drug database, covering the most-prescribed brands in the country.

**3. Check** — Three APIs run in parallel:
- **RxNorm (NLM)** — resolves generics to standard drug IDs
- **OpenFDA** — pulls real FDA-approved label warnings and contraindications
- **NLM Drug Interaction API** — checks all drug pairs against the ONCHigh dataset

**4. Reason** — Claude Opus 4.7 reads the API evidence and the patient profile (age, pregnancy, diabetes, heart disease, G6PD deficiency, allergies, other medications) and raises flags only where the data supports it — with a verified citation for every single flag.

**5. Flag** — The patient sees plain-language risk descriptions, severity badges, and a direct link to the source FDA label or NLM data. One instruction. Always the same: return to your doctor.

---

## What RxGuard never does

These are hard constraints enforced at the architecture level — Claude is instructed to violate any of these rules makes its output invalid:

- ❌ Recommend alternative medications
- ❌ Suggest dose or frequency changes
- ❌ Tell a patient to stop or skip a medication
- ❌ Diagnose any condition
- ❌ Explain what a medicine is "for"
- ❌ Store patient data beyond the current session
- ❌ Raise a flag without a real, verifiable citation

The only recommendation ever shown: *"Return to your doctor before taking these medicines."*

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite |
| Backend | Node.js + Express |
| AI | Claude Opus 4.7 — vision OCR + safety reasoning |
| Drug interactions | NLM Drug Interaction API (ONCHigh dataset) |
| Drug labels | OpenFDA |
| Drug ID | RxNorm (NLM) |
| Brand database | Custom Bangladesh brands JSON (200+ brands) |

---

## Setup

### Prerequisites
- Node.js 18+
- Anthropic API key ([get one here](https://console.anthropic.com))

### 1. Clone
```bash
git clone https://github.com/Mishkat96/Rxguard.git
cd Rxguard
```

### 2. Backend
```bash
cd server
npm install
cp .env.example .env
# Paste your Anthropic API key into .env
node index.js
```

### 3. Frontend
```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

---

## Environment variables

```
ANTHROPIC_API_KEY=your_key_here
PORT=8000
```
