#!/usr/bin/env bash
# Per-user installer for the omp-ui AppImage. Installs, repairs, and
# uninstalls without root; safe to pipe from curl:
#   curl -fsSL https://raw.githubusercontent.com/LankfordAI/omp-ui/main/packaging/install.sh | bash
set -euo pipefail

REPO="LankfordAI/omp-ui"
API_URL="https://api.github.com/repos/$REPO/releases/latest"
DOWNLOAD_BASE="https://github.com/$REPO/releases/download"
APP_ID="ai.lankford.omp-ui"

BIN_DIR="$HOME/.local/bin"
TARGET="$BIN_DIR/omp-ui.AppImage"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APPLICATIONS_DIR="$DATA_HOME/applications"
DESKTOP_FILE="$APPLICATIONS_DIR/$APP_ID.desktop"
HICOLOR_DIR="$DATA_HOME/icons/hicolor"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/@omp-ui/desktop"

WORKDIR=""
cleanup() {
    if [ -n "$WORKDIR" ] && [ -d "$WORKDIR" ]; then
        rm -rf "$WORKDIR"
    fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

err() {
    printf '%s\n' "install.sh: $*" >&2
}

die() {
    err "$*"
    exit 1
}

usage() {
    cat <<'EOF'
usage: install.sh [--version <vX.Y.Z>] [--binary <path>]
       install.sh --uninstall [--purge]
       install.sh --help

Installs the omp-ui AppImage for the current user (no root required).

options:
  --version <vX.Y.Z>  install a specific release (default: latest)
  --binary <path>     install a local AppImage instead of downloading
  --uninstall         remove the AppImage, desktop entry, and icons;
                      preserves user data in ~/.config/@omp-ui/desktop
  --purge             with --uninstall, also remove ~/.config/@omp-ui/desktop
  --help              show this help and exit
EOF
}

usage_error() {
    err "$*"
    usage >&2
    exit 2
}

# Prints the tag (e.g. v0.3.3) for the requested version: the argument
# normalized to a leading-v tag, or the latest release tag from the API.
resolve_version() {
    local requested="$1"
    if [ -n "$requested" ]; then
        local normalized="${requested#v}"
        case "$normalized" in
            ''|*[!0-9.]*|*..*|.*|*.)
                die "invalid version: $requested"
                ;;
        esac
        printf 'v%s\n' "$normalized"
        return
    fi
    local response tag
    response="$(curl -fsSL -H "User-Agent: omp-ui-installer" "$API_URL")" \
        || die "failed to query the latest release from $API_URL"
    tag="$(printf '%s\n' "$response" \
        | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        | head -n 1)"
    [ -n "$tag" ] || die "could not parse tag_name from the GitHub API response"
    printf '%s\n' "$tag"
}

# Downloads the AppImage and SHA256SUMS.txt for $1 (tag) into $WORKDIR and
# verifies the checksum. Fail-closed: any missing or mismatching checksum
# aborts before the existing install is touched. Prints the verified file.
download_and_verify() {
    local tag="$1"
    local version="${tag#v}"
    local asset="omp-ui-$version.AppImage"
    local sums="SHA256SUMS.txt"

    curl -fsSL -H "User-Agent: omp-ui-installer" \
        -o "$WORKDIR/$asset" "$DOWNLOAD_BASE/$tag/$asset" \
        || die "failed to download $DOWNLOAD_BASE/$tag/$asset"
    curl -fsSL -H "User-Agent: omp-ui-installer" \
        -o "$WORKDIR/$sums" "$DOWNLOAD_BASE/$tag/$sums" \
        || die "failed to download $DOWNLOAD_BASE/$tag/$sums (cannot verify checksum)"

    local line
    line="$(awk -v f="$asset" '$2 == f { print; exit }' "$WORKDIR/$sums")"
    [ -n "$line" ] || die "$sums has no checksum line for $asset; refusing to install"

    (cd "$WORKDIR" && printf '%s\n' "$line" | sha256sum -c - >/dev/null) \
        || die "sha256 checksum mismatch for $asset; refusing to install"

    printf '%s\n' "$WORKDIR/$asset"
}

# Stages $1 (a verified or user-supplied AppImage) into $BIN_DIR and renames
# it onto $TARGET. The rename is atomic within the directory, so an existing
# install is only ever replaced by a complete file.
install_appimage() {
    local src="$1"
    mkdir -p "$BIN_DIR"
    local staged="$BIN_DIR/.omp-ui.AppImage.partial.$$"
    cp -- "$src" "$staged"
    chmod 0755 "$staged"
    mv -f -- "$staged" "$TARGET"
}

# Extracts icons from the installed AppImage via --appimage-extract (works
# without FUSE) into the per-user hicolor tree. Icon failure is not fatal:
# the desktop entry is the hard requirement.
install_icons() {
    local extract_dir="$WORKDIR/extract"
    mkdir -p "$extract_dir"
    if ! (cd "$extract_dir" && "$TARGET" --appimage-extract >/dev/null 2>&1); then
        err "warning: could not extract icons from the AppImage; skipping icon install"
        return 0
    fi
    local root="$extract_dir/squashfs-root"
    if [ ! -d "$root" ]; then
        err "warning: AppImage extraction produced no squashfs-root; skipping icon install"
        return 0
    fi

    local installed=0
    local src rest size
    for src in "$root"/usr/share/icons/hicolor/*/apps/"$APP_ID".*; do
        [ -f "$src" ] || continue
        rest="${src#"$root"/usr/share/icons/hicolor/}"
        size="${rest%%/*}"
        mkdir -p "$HICOLOR_DIR/$size/apps"
        cp -- "$src" "$HICOLOR_DIR/$size/apps/$(basename "$src")"
        chmod 0644 "$HICOLOR_DIR/$size/apps/$(basename "$src")"
        installed=1
    done

    # Fallback: some AppImages only carry a root-level icon.
    if [ "$installed" -eq 0 ]; then
        local fallback=""
        if [ -f "$root/$APP_ID.png" ]; then
            fallback="$root/$APP_ID.png"
        elif [ -f "$root/.DirIcon" ]; then
            fallback="$root/.DirIcon"
        fi
        if [ -n "$fallback" ]; then
            mkdir -p "$HICOLOR_DIR/256x256/apps"
            cp -- "$fallback" "$HICOLOR_DIR/256x256/apps/$APP_ID.png"
            chmod 0644 "$HICOLOR_DIR/256x256/apps/$APP_ID.png"
            installed=1
        fi
    fi

    if [ "$installed" -eq 0 ]; then
        err "warning: no $APP_ID icon found inside the AppImage; skipping icon install"
    fi
}

# The desktop spec does not expand ~, so Exec carries the absolute path.
write_desktop_entry() {
    mkdir -p "$APPLICATIONS_DIR"
    cat >"$DESKTOP_FILE" <<EOF
[Desktop Entry]
Name=omp-ui
Comment=Desktop GUI for the omp coding agent
Exec="$TARGET" %U
Icon=$APP_ID
Type=Application
Categories=Development;
Terminal=false
StartupWMClass=omp-ui
EOF
    chmod 0644 "$DESKTOP_FILE"
}

refresh_caches() {
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
    fi
    # index.theme may not exist in a per-user hicolor tree; tolerate failure.
    if command -v gtk-update-icon-cache >/dev/null 2>&1 && [ -d "$HICOLOR_DIR" ]; then
        gtk-update-icon-cache -t -f "$HICOLOR_DIR" >/dev/null 2>&1 || true
    fi
}

do_install() {
    local version="$1" binary="$2"

    WORKDIR="$(mktemp -d)"

    local staged_appimage
    if [ -n "$binary" ]; then
        [ -f "$binary" ] && [ -r "$binary" ] \
            || die "binary not found or not readable: $binary"
        cp -- "$binary" "$WORKDIR/omp-ui.AppImage"
        staged_appimage="$WORKDIR/omp-ui.AppImage"
    else
        local tag
        tag="$(resolve_version "$version")"
        staged_appimage="$(download_and_verify "$tag")"
    fi

    install_appimage "$staged_appimage"
    install_icons
    write_desktop_entry
    refresh_caches

    printf 'omp-ui installed: %s\n' "$TARGET"
}

do_uninstall() {
    local purge="$1"
    local found=0

    if [ -e "$TARGET" ]; then
        rm -f -- "$TARGET"
        found=1
    fi
    if [ -e "$DESKTOP_FILE" ]; then
        rm -f -- "$DESKTOP_FILE"
        found=1
    fi

    local icon
    for icon in "$HICOLOR_DIR"/*/apps/"$APP_ID".*; do
        [ -e "$icon" ] || continue
        rm -f -- "$icon"
        found=1
    done

    if [ "$purge" -eq 1 ]; then
        if [ -d "$CONFIG_DIR" ]; then
            rm -rf -- "$CONFIG_DIR"
            printf 'removed user data: %s\n' "$CONFIG_DIR"
        fi
    elif [ -d "$CONFIG_DIR" ]; then
        printf 'kept user data: %s (use --purge to remove)\n' "$CONFIG_DIR"
    fi

    refresh_caches

    if [ "$found" -eq 0 ]; then
        printf 'omp-ui is not installed; nothing to do\n'
    else
        printf 'omp-ui uninstalled\n'
    fi
}

main() {
    local version="" binary="" uninstall=0 purge=0

    while [ $# -gt 0 ]; do
        case "$1" in
            --version)
                [ $# -ge 2 ] || usage_error "--version requires an argument"
                version="$2"
                shift 2
                ;;
            --binary)
                [ $# -ge 2 ] || usage_error "--binary requires an argument"
                binary="$2"
                shift 2
                ;;
            --uninstall)
                uninstall=1
                shift
                ;;
            --purge)
                purge=1
                shift
                ;;
            --help|-h)
                usage
                exit 0
                ;;
            *)
                usage_error "unknown option: $1"
                ;;
        esac
    done

    if [ "$uninstall" -eq 1 ]; then
        [ -z "$version" ] || usage_error "--version cannot be combined with --uninstall"
        [ -z "$binary" ] || usage_error "--binary cannot be combined with --uninstall"
        do_uninstall "$purge"
    else
        [ "$purge" -eq 0 ] || usage_error "--purge is only meaningful with --uninstall"
        do_install "$version" "$binary"
    fi
}

main "$@"
