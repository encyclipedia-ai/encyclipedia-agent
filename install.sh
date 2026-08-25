#!/usr/bin/env bash
# Encyclipedia Librarian — one-line install for Mac and Linux.
# Usage: curl -fsSL https://raw.githubusercontent.com/encyclipedia-ai/encyclipedia-agent/main/install.sh | bash
set -euo pipefail

REPO="${ENCYCLIPEDIA_AGENT_REPO:-encyclipedia-ai/encyclipedia-agent}"
BIN_DIR="${HOME}/.encyclipedia/bin"
BIN="${BIN_DIR}/encyclipedia-agent"

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "${os}-${arch}" in
  darwin-arm64) asset="encyclipedia-agent-darwin-arm64" ;;
  darwin-x86_64) asset="encyclipedia-agent-darwin-x64" ;;
  linux-x86_64|linux-amd64) asset="encyclipedia-agent-linux-x64" ;;
  linux-aarch64|linux-arm64) asset="encyclipedia-agent-linux-arm64" ;;
  *) die "This installer does not support ${os} ${arch} yet. See https://github.com/${REPO}/releases" ;;
esac

mkdir -p "${BIN_DIR}"

tmp="$(mktemp)"
cleanup() { rm -f "${tmp}"; }
trap cleanup EXIT

say "Installing Encyclipedia Librarian…"
url="https://github.com/${REPO}/releases/latest/download/${asset}"
if curl -fsSL "${url}" -o "${tmp}"; then
  mv "${tmp}" "${BIN}"
  chmod 755 "${BIN}"
  trap - EXIT
else
  say "No prebuilt download yet — building from source (needs Node 20+)…"
  command -v node >/dev/null || die "Node.js 20+ is required until a Librarian release is published."
  src="$(mktemp -d)"
  curl -fsSL "https://github.com/${REPO}/archive/refs/heads/main.tar.gz" | tar -xz -C "${src}" --strip-components=1
  (
    cd "${src}"
    if command -v pnpm >/dev/null; then
      pnpm install --frozen-lockfile
      pnpm build
    else
      npm install
      npx tsc -p tsconfig.json
    fi
    # Launcher that does not require a global install.
    cat > "${BIN}" <<EOF
#!/usr/bin/env bash
exec "$(command -v node)" "${BIN_DIR}/encyclipedia-agent.mjs" "\$@"
EOF
    chmod 755 "${BIN}"
    npx --yes esbuild src/index.ts --bundle --platform=node --format=esm --outfile="${BIN_DIR}/encyclipedia-agent.mjs" --banner:js="#!/usr/bin/env node"
  )
  rm -rf "${src}"
fi

path_line='export PATH="$HOME/.encyclipedia/bin:$PATH"'
add_path() {
  local file="$1"
  [[ -f "${file}" ]] || return 0
  grep -Fqs '.encyclipedia/bin' "${file}" && return 0
  printf '\n# Encyclipedia Librarian\n%s\n' "${path_line}" >> "${file}"
}
add_path "${HOME}/.zprofile"
add_path "${HOME}/.zshrc"
add_path "${HOME}/.bashrc"
add_path "${HOME}/.profile"

if [[ -d /usr/local/bin ]] && [[ -w /usr/local/bin ]]; then
  ln -sf "${BIN}" /usr/local/bin/encyclipedia-agent
fi
mkdir -p "${HOME}/.local/bin"
ln -sf "${BIN}" "${HOME}/.local/bin/encyclipedia-agent" 2>/dev/null || true

say ""
say "Installed to ${BIN}"
say "Next: sign in with your encyclipedia.ai email. Librarian will keep running after that."
say ""
exec "${BIN}"
