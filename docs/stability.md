# Stability Score & TUI Columns

## TUI Columns

| Column | Sort key | Description |
|--------|----------|-------------|
| **❔** | click / `V` | Tiny verdict indicator. Same sorting as **Verdict**, but emoji-only for fast scanning. |
| **Rank** | `R` | Position based on current sort order (medals for top 3: 🥇🥈🥉) |
| **Tier** | - | SWE-bench tier (S+, S, A+, A, A-, B+, B, C) |
| **SWE%** | `S` | SWE-bench Verified score - industry-standard for coding |
| **CTX** | `C` | Context window size (e.g. `128k`) |
| **Model** | `M` | Model display name (favorites show ⭐ prefix) |
| **Provider** | `O` | Provider name - press `D` to cycle provider filter |
| **Last P.** | `L` | Most recent round-trip latency in milliseconds |
| **Avg P.** | `A` | Rolling average of measurable pings since launch |
| **Health** | `H` | Current status: UP ✅, NO KEY 🔑, Timeout ⏳, Overloaded 🔥, Not Found 🚫 |
| **Verdict** | `V` | Human-readable health verdict based on avg latency + stability, using the same emoji as **❔**. |
| **Stability** | `B` | Composite 0-100 consistency score (see below) |
| **Up%** | `U` | Uptime - percentage of successful pings |
| **AI Latency** | click header | Real-answer benchmark wall-clock latency from `Ctrl+A` / `Ctrl+U`. |
| **TPS** | click header | Real-answer benchmark throughput, rounded tokens per second. |

---

## Verdict values

| Display | Verdict | Meaning |
|---------|---------|---------|
| **🟩 Perfect** | `Perfect` | Avg < 400ms with stable p95/jitter. |
| **🟢 Normal** | `Normal` | Avg < 1000ms, consistent responses. |
| **🟡 Spiky** | `Spiky` | Good avg but erratic tail latency (p95 >> avg). |
| **🟠 Slow** | `Slow` | Avg 1000-2999ms. |
| **🔴 Very Slow** | `Very Slow` | Avg 3000-4999ms. |
| **🔥 Overloaded** | `Overloaded` | Server returned 429/503 (rate limited or capacity hit). |
| **🟥 Unstable** | `Unstable` | Was previously up but now timing out, or avg > 5000ms. |
| **⚫ Not Active** | `Not Active` | No successful pings yet and the model is currently down/timeout. |
| **⏳ Pending** | `Pending` | First usable latency sample is still missing. |

---

## Stability Score formula

The **Stability** column answers: *"How consistent and predictable is this model?"*

Average latency alone is misleading. A model averaging 250ms that randomly spikes to 6 s *feels* slower than a steady 400ms model. The stability score captures this.

Four signals, normalized to 0-100, combined with weights:

```
Stability = 0.30 × p95_score
          + 0.30 × jitter_score
          + 0.20 × spike_score
          + 0.20 × reliability_score
```

| Component | Weight | What it measures | Normalization |
|-----------|--------|-----------------|---------------|
| **p95 latency** | 30% | Worst 5% of response times | `100 × (1 - p95 / 5000)`, clamped 0-100 |
| **Jitter (σ)** | 30% | Standard deviation of ping times | `100 × (1 - jitter / 2000)`, clamped 0-100 |
| **Spike rate** | 20% | Fraction of pings above 3000ms | `100 × (1 - spikes / total_pings)` |
| **Reliability** | 20% | Fraction of HTTP 200 pings | Direct uptime % (0-100) |

**Example:** Model A: avg 250ms, p95 6000ms → score ~30. Model B: avg 400ms, p95 650ms → score ~85. Model B *feels* faster in real usage.
