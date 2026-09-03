# Setting up a WebCIP server

One-time setup for a fresh box. After this, updates are one command:

```bash
ssh <host> /opt/webcip/deploy/deploy.sh
```

The app is served at `https://<host>/webcip/`, alongside the existing PHP site at `/`. Apache
proxies the whole `/webcip/` subtree to a uvicorn process on `127.0.0.1:8011`, which serves both
the built SPA and the API — the same thing it does locally, so what you test is what runs.

## Layout

Example paths, used throughout this document. See below for changing them.

| Path | What |
|---|---|
| `/opt/webcip` | this repo |
| `/opt/webcip/.venv` | the Python environment |
| `/opt/pypv` | the desktop tree (`pv_core`, `projects`, `desktop`, `install`), `WEBCIP_SRC` |
| `/opt/pypv/jobs` | tool scratch — **must be writable by the login account** |
| `/var/lib/webcip/uploads` | uploaded scans, `WEBCIP_UPLOAD_DIR` |
| `/var/lib/webcip/data` | scans put on the box by hand, `WEBCIP_DATA_ROOT` |

### These paths are examples

Nothing depends on `/opt` — put the trees wherever suits the box. `deploy/install.sh` rewrites all
of them at once, so the three files that must agree cannot drift apart:

```bash
APP=/srv/webcip SRC=/srv/pypv VAR=/srv/webcip-data ./deploy/install.sh
```

Three things are **not** free:

- **Not under `/var/www`** (or any DocumentRoot). Anything in there is potentially served as a
  static file, and `uploads/` holds patient scans.
- **The job directory is not relocatable.** `pv_core.tools.jobs` derives it from where the
  `pv_core` package sits on disk — always `<pypv checkout>/jobs/cip`, with no environment
  override. So it follows `WEBCIP_SRC` wherever that goes, and it must be writable by the service
  account and listed in the unit's `ReadWritePaths`. Its silent fallback when it isn't writable is
  the tempdir, which breaks the docker bind mounts — see the note in `webcip.service`.
- **Docker must be able to see the job directory.** The tools bind-mount it, and the *daemon*
  resolves that path, not the service — so a location the daemon cannot reach (a user-namespaced
  or unusual mount) will fail at run time rather than at start-up.

Apache does not care where any of it lives: it proxies to a **port**. The only path in the vhost
is the deny rule for a stale copy under DocumentRoot.

## Sizing

Measured on the dev box (20 cores / 31 GB) with `PID_1941_PLANID_523_RIGHT`, 2026-09-02 —
`docker stats` sampled through a real run:

| | Peak RSS | CPU | Wall |
|---|---|---|---|
| backend, idle | 0.48 GB | — | — |
| backend, preop + postop loaded | 1.15 GB | — | — |
| **`cip/dq`** (atlas registration) | **5.34 GB** | up to **1890%** (~19 cores) | ~31 s |
| `cip/pcisp` (segment) | 1.22 GB | **~101%** — single-threaded but for one brief spike | 88 s |

**RAM is the binding constraint, and it is `cip/dq`, not the backend.** The backend itself is
modest: 0.48 GB of imports (vtk + PySide6 + SimpleITK) plus roughly 2× the raw voxels per loaded
CT. But the deep-learning registration peaked at **5.3 GB in the container**, and that has to
coexist with the ~1.2 GB backend. So:

- **8 GB is the realistic floor** (5.3 + 1.2 + OS, with little headroom, and a larger CT than this
  one would need more).
- **16 GB is the comfortable figure** and what to ask for if the choice is free.
- **4 GB will not run the pipeline** — `cip/dq` alone exceeds it and the step will be OOM-killed.

**Cores matter less than expected.** The two heavy tools behave oppositely: `cip/dq` saturates
every core it is given, while `cip/pcisp` — the *longer* step — is essentially single-threaded, so
extra cores do nothing for it. **4 vCPU** is a sensible target; 2 costs a few extra minutes per
run rather than making it infeasible. Do not buy 8 cores expecting the 88 s segmentation to halve.

**Disk: ~100 GB.** 3.8 GB of tool images, 270 MB of `node_modules`, `jobs/` at 0.6-2 GB *per run*
(9.3 GB accumulated on the dev box before pruning), 350 MB per uploaded CT. Alarm at 80%.

### The current target box (34.198.28.2, measured 2026-09-02)

| | Available | Needed |
|---|---|---|
| RAM | **3.8 GB**, no swap | 8 GB floor |
| vCPU | 2 | 4 preferred, 2 workable |
| Disk (`/`) | **8.3 GB free** of 50 GB (`/var/lib/docker` already 4.8 GB of MATLAB images) | ~100 GB |

It can serve the **viewer** comfortably — displaying `.pwi` and `.cdb` needs neither Docker nor
much memory. It cannot run the **pipeline**: `cip/dq` peaks above the box's entire RAM, and the
four images are 3.8 GB of the 8.3 GB free before `jobs/` takes its 0.6-2 GB per run.

Either grow the instance (RAM first, cores second) and its root volume, or deploy viewer-only here
and run the pipeline elsewhere. Nothing below assumes one or the other — the Docker steps are
simply inert without the images.

## 1. Directories

Everything runs as the ordinary login account (`ec2-user` on Amazon Linux) — no service user. On
an Amazon Linux AMI that account is already in the `docker` and `wheel` groups, which is all the
service needs, so this step is just the data directories:

```bash
sudo mkdir -p /var/lib/webcip/{uploads,data}
sudo chown -R ec2-user:ec2-user /var/lib/webcip
chmod 750 /var/lib/webcip/uploads
```

They do not have to be there — `WEBCIP_UPLOAD_DIR` and `WEBCIP_DATA_ROOT` can point anywhere,
including a separate data volume. Under the login account's home is fine too; the unit sets
`ProtectHome=no` precisely because the service's own `$HOME` is under `/home`.

**The trade-off you are accepting.** The web service and your interactive SSH access share one
identity, and that identity is in the `docker` group, which is root-equivalent on the host. With
no authentication in front of the app (see "Not done yet"), anything that compromises the backend
gets your account. A dedicated service user would not fix that on its own, but it would limit the
blast radius. Reasonable for a single-operator research box; revisit it if the box ever holds real
patient data or faces the open internet.

## 2. The two repositories

Read-only GitHub **deploy keys**, one per repo (a deploy key cannot span repos):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_webcip -N ''
ssh-keygen -t ed25519 -f ~/.ssh/id_pypv   -N ''
# add each .pub to its repo's Settings -> Deploy keys
cat >> ~/.ssh/config <<'EOF'
Host github-webcip
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_webcip
  IdentitiesOnly yes
Host github-pypv
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_pypv
  IdentitiesOnly yes
EOF
sudo mkdir -p /opt && sudo chown ec2-user:ec2-user /opt   # or clone somewhere already writable
git clone github-webcip:nvrads/webcip /opt/webcip
git clone -b cip github-pypv:nvrads/pypv /opt/pypv
```

## 3. Python — **3.10 or newer is required**

Amazon Linux 2 ships **Python 3.9**, which is not enough: the backend's Pydantic models use
`str | None` (PEP 604), evaluated at import time, and `numpy 2.2` has no 3.9 wheels. Check first:

```bash
python3 -V          # 3.9.x on a stock AL2 box
```

If it is below 3.10, the least painful route on AL2 is Miniconda for the interpreter alone — the
same arrangement as the dev box, where conda supplies Python and every package still comes from
PyPI:

```bash
curl -fsSLo /tmp/mc.sh https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh
bash /tmp/mc.sh -b -p ~/miniconda3
~/miniconda3/bin/conda create -y -p /opt/webcip/.venv python=3.10
/opt/webcip/.venv/bin/pip install -r /opt/webcip/backend/requirements.lock.txt
```

On a distro that already has 3.10+, a plain venv is better — smaller, and it pins reproducibly
from the same lockfile:

```bash
python3 -m venv /opt/webcip/.venv
/opt/webcip/.venv/bin/pip install -r /opt/webcip/backend/requirements.lock.txt
```

Either way the unit's `ExecStart` points at `/opt/webcip/.venv/bin/uvicorn`, so the choice is
invisible to everything else.

**Node** is needed for the frontend build and is not on a stock AL2 box:

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo yum install -y nodejs
```

Alternatively, skip Node on the server entirely: `frontend/dist` is self-contained, so you can
build it on the dev box and `rsync` it across. Then `deploy.sh` needs its build step commented out.

## 4. Headless Qt / OpenGL

`import projects.cip` pulls in PySide6 and the `desktop` package. No window is ever created, but
the Qt platform plugin still has to load:

```bash
# Amazon Linux / RHEL
sudo yum install -y mesa-libGL mesa-libEGL libglvnd-glx libxkbcommon-x11 \
  xcb-util-image xcb-util-keysyms xcb-util-renderutil xcb-util-wm \
  dbus-libs fontconfig freetype libXrender libXi libXt

# Debian / Ubuntu
apt install -y libgl1 libglx-mesa0 libegl1 libopengl0 libglu1-mesa \
  libxkbcommon-x11-0 libxcb-cursor0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 \
  libxcb-randr0 libxcb-render-util0 libxcb-shape0 libxcb-xfixes0 libxcb-xinerama0 \
  libdbus-1-3 libfontconfig1 libfreetype6 libxrender1 libxi6 libxt6
```

The exact set varies by Qt build. The authoritative test is:

```bash
env QT_QPA_PLATFORM=offscreen PYTHONPATH=/opt/pypv \
    /opt/webcip/.venv/bin/python -c "import projects.cip; print('qt ok')"
```

A missing package shows up as `libGL.so.1: cannot open shared object file` or an xcb plugin error.

## 5. Docker and the four tool images

```bash
# Amazon Linux AMIs usually have Docker already, with ec2-user in the docker group. Check:
docker version --format '{{.Server.Version}}' && id -nG | tr ' ' '\n' | grep -x docker
# if absent: sudo yum install -y docker && sudo systemctl enable --now docker
#            sudo usermod -aG docker ec2-user   (log out and back in)
```

The images are **local-only — there is no registry to pull from**. Export them from a machine
that has them and copy them across (~3.8 GB):

```bash
# on the dev box
docker save cip/dq:headlocnet cip/jn:pix2pix cip/pcisp:1.0 cip/amir:5.0.5 | gzip -1 > cip-images.tgz
# on the server
docker load < cip-images.tgz
docker image inspect cip/dq:headlocnet cip/jn:pix2pix cip/pcisp:1.0 cip/amir:5.0.5 \
    >/dev/null && echo "docker ok"
```

That last command checks both things at once: the images are present *and* the account is in the
docker group.

**`atlas.nii` and `cip.lic` are not needed.** The atlas step is deep-learning/matrix-only and
handles the file being absent; the licence gate is desktop-only and the backend never calls it.
Both are gitignored in pypv — don't go looking for them.

## 6. The service

```bash
/opt/webcip/deploy/install.sh              # add APP=/… SRC=/… VAR=/… to relocate
systemctl enable --now webcip webcip-prune.timer webcip-restart.timer
curl -s localhost:8011/api/health          # {"ok":true}
```

`install.sh` also drops the Apache config into `conf-available` (§7 enables it).

`deploy.sh` ends with `sudo -n systemctl restart webcip`. On Amazon Linux `ec2-user` is in
`wheel` with blanket `NOPASSWD`, so that already works — verify with `sudo -n true`. If your box
requires a password for sudo, add just this:

```bash
echo 'ec2-user ALL=(root) NOPASSWD: /usr/bin/systemctl restart webcip' \
  | sudo tee /etc/sudoers.d/webcip && sudo chmod 440 /etc/sudoers.d/webcip
sudo visudo -c        # never leave a syntax error here — it can lock you out of sudo
```

**Why the timers:** `webcip-prune` is the ONLY thing that removes old tool-run directories. It is
age-based (7 days) rather than count-based, and runs as root because the containers write their
output as root. The backend deliberately does not prune at startup: `pv_core.tools.jobs.prune()`
keeps only the 5 most recent runs, which is fine for a desktop that starts once a session but
destroys history on a server that restarts on every deploy. `webcip-restart` reclaims the image
cache nightly — `_STORE` holds every decoded CT for the life of the process.

## 7. Apache

`install.sh` has already dropped the config in the right place. On Amazon Linux / RHEL that is
`/etc/httpd/conf.d/webcip.conf`, which is active as soon as Apache reloads:

```bash
httpd -M | grep -E 'proxy_module|proxy_http_module'   # both are loaded by default on AL2
sudo apachectl configtest && sudo systemctl reload httpd
```

On Debian/Ubuntu it lands in `conf-available` instead and needs
`a2enmod proxy proxy_http && a2enconf webcip`.

**Check the PHP site for rewrites that would swallow `/webcip`** — a front controller in the
vhost, or an `.htaccess` at the DocumentRoot. A rewrite scoped to a subdirectory (a Drupal install
under `/drupal`, say) is fine and needs no change.

## 8. Prove it works

```bash
curl -sI  https://<host>/webcip                       # 301 -> /webcip/
curl -s   https://<host>/webcip/ | grep -o 'src="[^"]*"'   # ./assets/... , all relative
curl -s   https://<host>/webcip/api/health
curl -sI  https://<host>/                             # the PHP site, unchanged
```

Then in a browser at `https://<host>/webcip/`, with the network panel open: **every** request must
be under `/webcip/`. A request to `/api/…` or `/icons/…` at the root means a root-absolute URL
survived the build — and the PHP site will answer it with 200 HTML, so it surfaces as a JSON parse
error rather than a clean 404.

Finally run one real case end to end (`Auto process`, or steps 3-6 by hand) with
`journalctl -u webcip -f` open. Confirm the run directory appeared under `/opt/pypv/jobs/cip/` and
**not** `/tmp/pypv_jobs/` — the latter means `/opt/pypv/jobs` is not writable, and the containers
are binding a directory they cannot see.

You can rehearse the subpath locally, without Apache:

```bash
python deploy/subpath_test.py     # http://127.0.0.1:8012/webcip/
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| Blank page, 404s on `/assets/…` | The `/webcip` → `/webcip/` redirect is missing, or the build lost `base: './'` |
| Page loads, API calls return HTML | A root-absolute URL survived; the PHP site is answering it |
| Progress bar jumps at the end instead of ticking | An Apache filter is buffering the SSE stream — check the `LocationMatch` block |
| `libGL.so.1: cannot open shared object file` | Missing Qt/GL packages (§4) |
| `docker CLI not found`, or EACCES on the socket | `webcip` is not in the docker group, or `ProtectSystem` is too strict |
| Tools run but find no input | `jobs_root()` fell back to `/tmp`; `/opt/pypv/jobs` is not writable |
| A second browser shows someone else's patient | One shared session — expected, see below |

## Not done yet

Deliberately out of scope for this deployment, in rough priority order:

- **No authentication, and `allow_origins=["*"]`.** `GET /api/browse?path=/` will list any
  directory the service user can read, and `/api/load|plan|cdb|case` will read any absolute path
  the client names — on a box whose service account is in the `docker` group. `browse` is dead
  code (nothing in the UI calls it) and can simply be deleted; the rest wants confining to
  `WEBCIP_DATA_ROOT`. **Put an Apache IP allowlist or basic auth in front until that is done.**
- **One shared workflow session.** Every browser drives the same `_SESSION`. The in-use banner
  makes a collision visible; it does not make concurrent work possible.
- **`_STORE` never evicts** — mitigated only by the nightly restart.
