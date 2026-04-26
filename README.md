# RxGuard

A prescription safety checker for patients in Bangladesh who have no pharmacist nearby.

A patient photographs a handwritten prescription, answers five questions about themselves, and RxGuard flags any known dangers — then tells them to return to their doctor.

Built for the **Built with Claude** hackathon using Claude Opus 4.7.

---

## What it does

1. **Reads handwritten prescriptions** — Bengali, English, or mixed, using Claude Opus 4.7 vision
2. **Translates brand names to generics** — using a curated Bangladesh drug database
3. **Checks drug interactions** — against NLM's ONCHigh dataset via RxNav API
4. **Checks FDA drug labels** — via OpenFDA for contraindications and warnings
5. **Flags patient-specific risks** — pregnancy, diabetes, heart disease, G6PD deficiency, allergies
6. **Never recommends alternatives or changes doses** — only ever says: return to your doctor

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite |
| Backend | Node.js + Express |
| AI | Claude Opus 4.7 (vision OCR + safety reasoning) |
| Drug data | RxNorm (NLM), OpenFDA, NLM Drug Interaction API |
| Brand DB | Custom Bangladesh brands JSON (bd_brands.json) |

---

## Setup

### Prerequisites
- Node.js 18+
- Anthropic API key

### 1. Clone the repo
```bash
git clone https://github.com/your-username/rxguard.git
cd rxguard
```

### 2. Backend
```bash
cd server
npm install
cp .env.example .env
# Add your Anthropic API key to .env
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

## Ethical constraints

RxGuard is built around hard ethical rules enforced at the architecture level:

- **Never** recommends alternative medications
- **Never** suggests dose changes
- **Never** tells a patient to stop or skip a medication
- **Never** diagnoses conditions
- **Never** stores patient data beyond the current session
- Every flag requires a real, verifiable citation (FDA label, NLM API, WHO EML)
- The only recommendation ever shown: *"Return to your doctor before taking these medicines."*

---

## Environment variables

```
ANTHROPIC_API_KEY=your_key_here
PORT=8000
```
