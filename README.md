# Traffic Deploy Simulator

A standalone prototype that simulates real-time deployment of traffic signal controllers using [CityFlow](https://cityflow.readthedocs.io/). RL agents **learn online** during each simulation run — no pre-trained checkpoints needed. The backend is FastAPI with WebSocket streaming; the web app is React + Vite with live learning curves and simulation replay.

---

## Table of Contents

- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
  - [1. Clone this repository](#1-clone-this-repository)
  - [2. Install the traffic-rl dependency](#2-install-the-traffic-rl-dependency)
  - [3. Install CityFlow](#3-install-cityflow)
  - [4. Backend setup](#4-backend-setup)
  - [5. Backend setup](#5-backend-setup)
- [Running the app](#running-the-app)
- [Project Structure](#project-structure)
- [How It Works](#how-it-works)
- [Available Agent Types](#available-agent-types)
- [API Reference](#api-reference)
- [Notes](#notes)
- [License](#license)

---

## Architecture

```
┌──────────────┐  WebSocket / REST   ┌──────────────────┐
│   React UI   │ ◄──────────────────► │  FastAPI Backend  │
│  (Vite dev)  │    localhost:3000    │  localhost:8000   │
└──────────────┘                     └────────┬─────────┘
                                              │
                                     ┌────────▼─────────┐
                                     │   traffic-rl     │
                                     │  (RL agents &    │
                                     │   CityFlow env)  │
                                     └────────┬─────────┘
                                              │
                                     ┌────────▼─────────┐
                                     │     CityFlow     │
                                     │  (C++ simulator) │
                                     └──────────────────┘
```

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Python** | ≥ 3.10 | Required by both `traffic-rl` and the backend |
| **Node.js** | ≥ 18 | For the Turbo monorepo and web app |
| **pnpm** | ≥ 9 | Workspace package manager |
| **Git** | any | To clone repositories |
| **CityFlow** | latest | C++ traffic simulator with Python bindings |
| **traffic-rl** | 0.1.0 | Sibling RL library — see [below](#2-install-the-traffic-rl-dependency) |

---

## Setup

### 1. Clone this repository

```bash
git clone git@github.com:hdmGOAT/traffic-deploy-sim.git
cd traffic-deploy-sim
```

### 2. Install the `traffic-rl` dependency

> **This project depends on [`traffic-rl`](https://github.com/hdmGOAT/traffic-rl)**, a separate RL library that provides the agent implementations (DQN, Double DQN, Dueling DQN, Tabular Q-Learning), the CityFlow environment wrapper, and training configs.

Clone `traffic-rl` as a **sibling directory** (recommended) or anywhere on your machine:

```bash
# From the parent directory of traffic-deploy-sim
cd ..
git clone git@github.com:hdmGOAT/traffic-rl.git
```

Your directory layout should look like:

```
ML_project/
├── traffic-deploy-sim/   # ← this repo
└── traffic-rl/           # ← RL agents & env wrappers
```

You will install `traffic-rl` into the backend venv in a later step.

### 3. Install CityFlow

CityFlow is a C++ traffic simulator with Python bindings. It must be built from source and installed into the same Python environment as the backend.

```bash
# Clone CityFlow
git clone https://github.com/cityflow-project/CityFlow.git
cd CityFlow

# Build and install into the active Python 3.10+ environment
pip install .
```

> **Tip:** If you run into build issues, see the [CityFlow documentation](https://cityflow.readthedocs.io/en/latest/install.html) for platform-specific instructions.

### 4. Install workspace dependencies

From the repository root:

```bash
pnpm install
```

### 5. Backend setup

```bash
cd traffic-deploy-sim/backend

# Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate      # Linux / macOS
# .venv\Scripts\activate       # Windows

# Install backend Python dependencies
pip install -r requirements.txt

# Install traffic-rl in editable mode (assumes sibling directory)
pip install -e ../../traffic-rl

# Install CityFlow into the same venv (if not already installed globally)
# pip install /path/to/CityFlow
```

Verify everything is installed:

```bash
python -c "import traffic_rl; import cityflow; print('✓ All dependencies loaded')"
```

The web app lives in [web](web) and is managed through the root workspace install.

---

## Running the app

Open **one terminal** from the repository root:

```bash
source backend/.venv/bin/activate
pnpm dev
```

Turbo will start the web app and backend together. The UI will be available at **http://localhost:3000** and the API at **http://localhost:8000**.

Open the web app in your browser and you're ready to go.

---

## Project Structure

```
traffic-deploy-sim/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI app — routes, WebSocket, simulation loop
│   │   ├── models.py            # Pydantic request/response schemas
│   │   ├── registry.py          # Model registry loader
│   │   └── model_registry.json  # Available RL agent definitions
│   ├── package.json             # Turbo wrapper scripts for the Python backend
│   └── requirements.txt         # Python dependencies (FastAPI, uvicorn, etc.)
├── web/
│   ├── src/
│   │   ├── App.jsx              # Main React component — live simulation UI
│   │   ├── ReplayPanel.jsx      # Replay controls for historical runs
│   │   ├── api.js               # API / WebSocket client helpers
│   │   ├── main.jsx             # React entry point
│   │   └── styles.css           # Global styles
│   ├── index.html               # HTML entry point
│   ├── vite.config.ts           # Vite configuration
│   └── package.json             # Web app package
├── data/
│   ├── roadnet_1x2.json         # 1×2 intersection road network
│   ├── roadnet_cross.json       # Single-cross intersection road network
│   ├── flow_1x2.json            # Default flow for 1×2
│   ├── flow_cross.json          # Default flow for cross
│   └── generated/               # Auto-generated flow/engine configs (gitignored)
├── package.json                 # Root Turbo scripts
├── pnpm-workspace.yaml          # Workspace package list
├── turbo.json                   # Turbo task pipeline
├── .github/
│   └── copilot-instructions.md
├── .gitignore
└── README.md
```

---

## How It Works

1. **Configure demand** — Set vehicle arrival rates on each ingress edge.
2. **Pick a controller** — Choose an RL agent type (DQN, Double DQN, Dueling DQN, Tabular Q), fixed-time, or random.
3. **Start the simulation** — The backend spins up CityFlow and the RL agent begins learning from scratch.
4. **Watch it learn** — The web app streams live metrics (queue length, throughput, reward, epsilon) and renders sparkline learning curves in real time.
5. **Replay past runs** — Use the replay panel to scrub through historical simulation metrics.

---

## Available Agent Types

| Agent | ID | Description |
|---|---|---|
| DQN | `dqn` | Deep Q-Network with replay buffer and target network |
| Double DQN | `double_dqn` | Reduces Q-value overestimation via decoupled selection/evaluation |
| Dueling DQN | `dueling_dqn` | Splits value and advantage streams for better feature learning |
| Tabular Q-Learning | `tabular_q` | Classic lookup-table Q-learning, fast convergence for small domains |
| Fixed-Time | — | Deterministic round-robin phase cycling |
| Random | — | Random phase selection (baseline) |

Agent types are registered in [`backend/app/model_registry.json`](backend/app/model_registry.json).

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/models` | List available agent types |
| `GET` | `/roadnet?roadnet_id=<path>` | Fetch road network JSON |
| `GET` | `/roadnet/edges?roadnet_id=<path>` | List ingress edges for demand config |
| `POST` | `/simulations` | Start a new simulation run |
| `GET` | `/simulations` | List all simulation runs |
| `GET` | `/simulations/{job_id}` | Get simulation status |
| `GET` | `/simulations/{job_id}/metrics` | Get all recorded metrics for a run |
| `WS` | `/simulations/{job_id}/stream` | Real-time metric stream via WebSocket |

---

## Notes

- Agents learn **online** (`train=True` + `observe`) — each simulation starts fresh with no pre-trained weights.
- Generated flow and engine config files are written to `data/generated/` and gitignored.
- Non-controlled intersections run a deterministic fixed-time cycle to keep traffic moving.
- The backend gracefully degrades if `traffic-rl` or `cityflow` are not installed (imports are wrapped in try/except).

---

## License

MIT
