# Contributing to x265-butler

Thanks for your interest in improving x265-butler! This document describes the process for proposing changes.

---

## TL;DR

1. **Sign the CLA** by signing-off every commit: `git commit -s -m "your message"`
2. **Open a Merge Request** on GitLab against the `dev` branch
3. **Match the existing style** (Prettier + ESLint enforced via CI)
4. **Reference an issue** when fixing a bug or adding a feature

---

## 1. Before You Start

### Bug reports

Open an issue first:

- **GitLab Issues:** <https://gitlab.com/MisterJB/x265-butler/-/issues>
- **unRAID Forum:** <https://forums.unraid.net/topic/182094-support-human-126094-docker-templates/>

Include: x265-butler version (`/api/health`), unRAID version, encoder used, relevant log excerpts (use `/diagnostics` page to export a redacted bundle).

### Feature requests

Open an issue with the `feature-request` label. Describe the use case before the implementation — small focused proposals get accepted faster than large speculative redesigns.

### Trivial fixes

Typos, doc tweaks, single-line bug fixes → skip the issue, open MR directly.

---

## 2. Contributor License Agreement (CLA)

**Every contribution requires CLA acceptance.** Read [CLA.md](CLA.md) once before your first contribution.

### How you accept the CLA

Each commit in your Merge Request must include a `Signed-off-by:` trailer that matches the commit author's email address. This sign-off is your acceptance of the CLA for that contribution.

**The easy way** — let Git add the trailer automatically:

```bash
git commit -s -m "fix: handle empty scan path"
```

The `-s` flag appends:

```
Signed-off-by: Your Name <your.email@example.com>
```

**Make it the default** for this repo so you never forget:

```bash
git config --local format.signOff true
```

### What gets enforced

CI runs a sign-off verification job on every Merge Request:

- Every non-merge commit in the MR must have a `Signed-off-by:` trailer
- The sign-off email must match the commit's author email
- Failing the check blocks the MR from being mergeable

If your MR fails the check, amend or rebase your commits to add the sign-off:

```bash
git rebase --signoff dev   # adds Signed-off-by to every commit in the range
git push --force-with-lease
```

### What the CLA grants

By signing-off, you grant the Project Owner (MisterJB) the right to relicense your contribution under any terms — including future commercial license terms. You retain full copyright and the right to use your own contribution however you like. Full text: [CLA.md](CLA.md).

---

## 3. Development Setup

```bash
git clone https://gitlab.com/MisterJB/x265-butler.git
cd x265-butler
npm install
npm run dev          # Next.js dev server on http://localhost:3000
```

SQLite database is created at `./data/x265-butler.db`. A seed script generates fake library entries so the UI is usable without `ffmpeg`.

For end-to-end testing with real encodes, build the Docker image:

```bash
docker build -t x265-butler:dev .
docker run --rm -p 8765:3000 -v $(pwd)/data:/config x265-butler:dev
```

---

## 4. Code Style

Enforced automatically — no manual judgment needed:

```bash
npm run lint         # ESLint + Prettier check
npm run format       # Prettier auto-fix
npm test             # Vitest unit tests
```

CI runs all three on every push. MRs failing lint or test cannot be merged.

**Test coverage target:** ≥70% for backend code (`src/`, `lib/`, `app/api/`). Frontend gets smoke tests only.

---

## 5. Commit Messages

Format: `<type>: <short summary>` (imperative mood, English, lowercase type).

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`.

Examples:

```
feat: add VAAPI hardware encoder auto-detection
fix: prevent path traversal in trash restore endpoint
docs: clarify CRF default in Settings page
```

Longer reasoning goes in the commit body (blank line after subject).

---

## 6. Merge Request Process

1. Fork the repo (or branch if you have direct access)
2. Branch off `dev` (NOT `main`): `git checkout -b fix/short-description dev`
3. Make your changes with signed-off commits
4. Push and open MR targeting `dev`
5. Fill in the MR template (auto-loaded — checkbox the CLA sign-off acknowledgment)
6. Wait for CI green + review feedback
7. Address review comments by force-pushing the same branch
8. Maintainer merges when ready

**Do not** open MRs against `main` — `main` is release-only and updated via `dev → main` merge at phase-close.

---

## 7. What Gets Rejected

To save everyone time, these usually get rejected:

- Massive refactors without prior discussion
- Style-only changes (we have Prettier for that)
- Dependency updates without a stated reason
- Features that bypass the existing Path safety / Subprocess safety guarantees (see README "Security" section)
- Changes that lower test coverage below 70%
- Commits without sign-off (CI blocks these automatically)

---

## 8. Code of Conduct

Be respectful. Disagreements are fine; personal attacks are not. The maintainer reserves the right to close MRs or block users for hostile behavior.

---

## 9. Questions

Open a Discussion on GitLab, ping in the unRAID forum thread, or open an issue with the `question` label.

Thanks for contributing!
