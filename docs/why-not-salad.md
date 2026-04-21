# Why Salad Cannot Power Pulse's Provider Model

## The Business Model Pulse Needs

Pulse acts as a **middleware aggregator** between GPU owners and compute buyers:

1. User signs up on Pulse
2. User downloads a Pulse agent / setup script
3. That agent registers their machine under **Pulse's master account** on a provider (Salad, Vast, etc.)
4. Pulse earns when that machine is rented out
5. Pulse distributes a share of those earnings to the user as PULSE tokens

This requires a provider that supports **programmatic machine registration under an organization account** — i.e., one API key that controls many machines owned by different people.

---

## Why Salad Cannot Do This
 
### 1. Salad Has Two Completely Separate Products

| Product | Who it's for | API exists? |
|---|---|---|
| **SaladCloud** (app.salad.com) | Buyers deploying AI workloads | ✅ Full REST API |
| **Salad Earner** (app.salad.io) | Individuals renting their GPU | ❌ No public API |

The SaladCloud API (which `fetchSaladEarnings` uses) is entirely the **buyer side** — you pay Salad to run container workloads on their network. It has nothing to do with being a GPU provider/earner.

### 2. The Earner Side Has No API

Salad's earner program works through a desktop app only:
- Users download the Salad app to their personal PC
- The app registers the machine to **that individual user's Salad account**
- Earnings (SaladBucks) accumulate in that personal account only
- There is **no API endpoint** to read another user's earnings, register machines programmatically, or pool machines under a master account

This is confirmed by Salad's official API reference (`docs.salad.com/reference`) which covers only SaladCloud (workload deployment) — earner node management is entirely absent.

### 3. No Reseller or Sub-Account Program

Salad does not offer:
- White-label earner programs
- Organization-level node pooling
- API-based machine onboarding under a parent account
- Revenue sharing or affiliate APIs for GPU providers

Every earner is an independent individual account. There is no mechanism for Pulse to sit in the middle.

### 4. The Existing `fetchSaladEarnings` Is Architecturally Wrong

The function calls:
- `GET /organizations/{org}/gpu-classes` — lists GPU pricing for buyers
- `GET /organizations/{org}/projects/{project}/containers` — lists container workloads Pulse deployed as a customer

This makes Pulse a **Salad customer paying for compute**, not a platform that earns by providing compute. The direction of money is backwards.

---

## Why Vast.ai Is the Right Pivot

Vast.ai is a GPU marketplace where **hosts** (GPU owners) list machines and **renters** (AI/ML users) pay to use them. Unlike Salad, Vast.ai exposes a full host-side API.

### What Vast.ai Supports That Salad Doesn't

| Capability | Salad | Vast.ai |
|---|---|---|
| Programmatic machine registration | ❌ | ✅ via setup script + API key |
| Earnings endpoint per machine | ❌ | ✅ `GET /api/v0/users/{id}/machine_earnings/` |
| List all machines under one account | ❌ | ✅ `GET /api/v0/machines/` |
| Manage pricing/availability via API | ❌ | ✅ `PUT /api/v0/machines/create_asks/` |
| Team / shared API key support | ❌ | ✅ Vast Teams feature |
| Organization-level host account | ❌ | ✅ |

### How Pulse Works With Vast.ai

1. Pulse creates one Vast.ai host account (the master account)
2. When a user joins Pulse, they receive a setup script that runs Vast.ai's host software using **Pulse's API key**
3. That machine registers under Pulse's Vast.ai account automatically
4. Pulse's backend polls `GET /api/v0/machines/` to see all registered machines and their rental status
5. Pulse polls `GET /api/v0/users/{id}/machine_earnings/` to get total earnings
6. Pulse distributes PULSE tokens to users proportional to their machine's contribution

This is exactly the hands-off aggregator model Pulse is designed around.

---

## Action Items

- [x] Remove Salad as a primary provider integration
- [x] Fix `fetchVastaiEarnings` to use the correct host earnings endpoint
- [x] Update `generateSetupScript` to produce a Vast.ai host onboarding script using Pulse's API key
- [x] Update `registerGPU` and `registerGPUDaemon` to store `vast_machine_id` per user GPU record
- [x] Add `vast_machine_id` and `active_platform` fields to GPU entity
- [x] Update UI (ConnectGPU page) to reflect Vast.ai — removed Salad refs, added setup script download
- [ ] Set `VASTAI_API_KEY` env var in base44 project settings (manual step — see below)

### Setting VASTAI_API_KEY

1. Go to your [base44 dashboard](https://base44.app) → your project → **Settings → Environment Variables**
2. Add: `VASTAI_API_KEY` = your Vast.ai host account API key
3. The key must belong to the Pulse master Vast.ai host account (not a personal account)
