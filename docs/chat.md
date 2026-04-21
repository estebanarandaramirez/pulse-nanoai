# Pulse — Provider Strategy Chat Log

---

> **Q:** Ok we seem to hit a wall here - Pulse is targeted towards gamers and virtually everyone plays on Windows. If we cannot make the system "approachable" to large masses - i.e. if it cant work with VMs or WSL2 - AND if we cannot use Salad as we discussed, what is the solution?

**A:** This is actually the core product question. Here are the real options:

1. **Salad — but rethink the integration model**
Salad is literally built for Windows gamers. The reason we rejected it was the "master account" model — but there's another approach: users install Salad normally on their own Windows PC, then link their Salad account to Pulse. Pulse becomes a dashboard + rewards layer on top. PULSE tokens are a bonus on top of their SaladBucks. The downside: you're dependent on Salad's unofficial/scraping-level API since their earner side has no public endpoints.

2. **NiceHash**
Designed for Windows gamers mining crypto with their GPU. Has a proper organizational API, supports Windows natively, easy installer. Pulse could route users to NiceHash under a Pulse pool account. This is the closest thing to what you originally described — a master account that multiple Windows users earn under. Worth investigating seriously.

3. **Build a Pulse Windows Agent**
A lightweight .exe that sits in the system tray, auto-pauses during gaming (like Salad), and routes compute jobs. Pulse becomes the marketplace directly. This is the highest effort but gives you full control — no dependency on Salad or Vast.

4. **Vast.ai + WSL2 as an "advanced" option**
Keep Vast.ai but make it opt-in for power users who have Linux or are comfortable with WSL2. Not for the mass market.

My recommendation: NiceHash in the short term (real Windows support + org API), Pulse Windows Agent as the long-term moat.

---

> **Q1:** In this scenario why would users use Pulse instead of Salad? And also what would be in it for us if we're just giving away free tokens?
> **Q2:** How much harder on a GPU is the crypto mining business?
> **Q3:** I think thats too much — we do not want to become another marketplace. What would be our advantage there to attract new customers? We want to be a middle man and re-direct the compute power to the highest bidder.
> **Q4:** IF WSL2 is an option we should give it a shot - what are the downsides to using these platforms (the system we have set up) with WSL2? Is it performance or something?

**A1:** Exactly the right concern. If users just install Salad themselves, Pulse adds nothing and you're burning tokens as fake incentives. That model only works if PULSE tokens appreciate in value — which is circular. There's no real value proposition there.

**A2:** Mining is significantly harder on hardware. It runs the GPU at 100% power draw constantly, maxes out memory bandwidth, and generates peak sustained heat. AI inference/compute workloads have varied utilization — the GPU breathes. Long-term mining meaningfully shortens GPU lifespan and voids warranties. Gamers would care about this.

**A3:** Agreed — don't build a marketplace. The aggregator/router model is the right call. The moat is the intelligence layer: Pulse auto-detects which provider pays best for your specific GPU right now and switches automatically. No user has time to monitor Vast vs Clore vs whatever else emerges. That's the real value.

**A4:** Viable, but with real costs:
- **~5–15% performance loss** — WSL2 runs inside Hyper-V, CUDA goes through a virtual GPU driver layer
- **Networking** — WSL2 is behind Windows NAT. Vast.ai needs specific ports open and reachable from the internet. Requires manual port forwarding on the router, which most gamers won't do
- **Reliability** — Windows can kill WSL2 anytime: updates, sleep, hibernate. Vast.ai scores hosts on uptime — a gaming PC running WSL2 will get a poor reliability score and attract fewer rentals
- **No auto-start** — WSL2 doesn't survive reboots without extra setup

The networking issue is the real blocker — not performance. Most gamers are behind a home router with no port forwarding configured, which Vast.ai requires to accept incoming jobs.

The providers that work for Windows without port forwarding or Linux are the ones where the connection is outbound — the client reaches out to the platform, the platform pushes jobs in. Salad works this way. NiceHash works this way. Vast.ai doesn't.

---

> **Q:** If WSL2 is viable can we create scripts to facilitate the setup/running of things on WSL2? So when the user first registers into Pulse and what not they download the script and set it up alongside WSL2 to streamline the process - they dont have to do much after the initial setup and earn money passively. If this is not viable then I think our option would be NiceHash?

**A:** WSL2 setup can absolutely be scripted end-to-end. The networking problem (port forwarding) can be solved with a **Cloudflare Tunnel** — free, no router configuration, no static IP needed. The user's machine opens an outbound tunnel and Vast.ai jobs come through it. No port forwarding required.

The full automated flow would be:
1. User downloads a single `pulse-setup.ps1`
2. Script silently enables WSL2 + installs Ubuntu — one reboot required
3. After reboot, script resumes automatically via Task Scheduler
4. Installs Vast.ai host client inside WSL2
5. Installs cloudflared and sets up a Cloudflare Tunnel for the required ports
6. Registers the machine with Pulse, gets machine ID
7. Sets up auto-start on login via Task Scheduler

After that — truly passive. Machine starts earning whenever Windows boots, pauses when the user is gaming (we hook into GPU utilization), resumes when idle.

Real downsides:
- **One reboot** during setup — unavoidable for WSL2
- **5–15% performance overhead** — means slightly lower earnings vs bare Linux, but still passive income
- **WSL2 can be disrupted by Windows updates** — need a watchdog in Task Scheduler to restart it
- **Cloudflare Tunnel adds latency** — fine for AI inference jobs, bad for real-time workloads

This is viable and worth building. NiceHash remains a good fallback for users whose machines WSL2 doesn't play nice with (older Windows, certain OEM configs).
