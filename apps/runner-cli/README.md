# autodev-runner

Runs AutoDev test jobs on your machine. It connects out to your AutoDev org (no inbound ports),
picks up jobs automatically while it's running, and runs only the commands in the repository's
`.autodev.yml`, in Docker by default.

## Install

Pick one:

- **Single binary** (no Node needed): download `autodev-runner-<os>-<arch>` for your platform from
  the GitHub release (macOS arm64/x64, Linux x64/arm64, Windows x64), make it executable, and put
  it on your `PATH` as `autodev`.
- **npm** (Node 18.18+): `npm install -g autodev-runner`

## Use

```bash
autodev login            # shows a code; approve it in the dashboard (Builders → Pair)
autodev bind <repo> .    # optional: reuse this clone for warm caches
autodev start            # connect and run jobs until you stop it
autodev start --no-docker
autodev status
```

The first job for each repository asks you to confirm in the dashboard. A job that changes
`.autodev.yml` needs your consent before it runs.

## Docker mode

Docker mode is on by default: each command runs in a fresh container from the job's image, with
CPU and memory limits. The runner needs a running Docker engine.

- **macOS:** Docker Desktop, OrbStack or Colima.
- **Linux:** Docker Engine; your user must be able to reach the Docker socket.
- **Windows:** **Docker Desktop with the WSL 2 backend** (Settings → General → "Use the WSL 2 based
  engine"). Linux containers are used; Windows containers aren't supported. Start Docker Desktop
  before `autodev start`.

Without Docker, use `autodev start --no-docker` (your own jobs only; shared team builders always
use Docker).

## Windows: long paths

Jobs run in a temporary git worktree, and deep repositories can exceed Windows' 260-character path
limit. The runner passes `core.longpaths=true` to every git command it runs, so git itself handles
long paths. If your build tools still fail on long paths, also enable them in Windows:

```powershell
# As administrator, then restart the terminal
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
git config --global core.longpaths true
```

## Presence

While running, the builder sends a heartbeat every 20 seconds. The dashboard shows it offline after
60 seconds without one; queued jobs wait and run as soon as it reconnects.
