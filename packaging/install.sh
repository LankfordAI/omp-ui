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
LAUNCHER="$BIN_DIR/omp-ui"
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

# The Linux release is x64-only (docs/releases.md). Fail before downloading.
require_x64() {
    local arch
    arch="$(uname -m)"
    [ "$arch" = "x86_64" ] \
        || die "this release only ships an x64 AppImage (this machine is $arch)"
}

# The Electron binary inside the AppImage links system GUI libraries the
# AppImage does not bundle. A no-root installer cannot install them, so verify
# resolution and fail with the exact fix command BEFORE touching the install.
check_prerequisites() {
    local root="$1"
    local bin="$root/omp-ui"          # executableName from electron-builder.yml
    if [ ! -f "$bin" ]; then
        err "warning: electron binary not found inside the AppImage; skipping prerequisite check"
        return 0
    fi
    if ! command -v ldd >/dev/null 2>&1; then
        err "warning: ldd not available; skipping prerequisite check"
        return 0
    fi

    local so pkg mapped=() unmapped=()
    while IFS= read -r so; do
        [ -n "$so" ] || continue
        pkg="$(so_to_package "$so")"
        if [ -n "$pkg" ]; then mapped+=("$pkg"); else unmapped+=("$so"); fi
    done < <(ldd "$bin" 2>/dev/null | awk '/not found/ {print $1}')

    if [ ${#mapped[@]} -eq 0 ] && [ ${#unmapped[@]} -eq 0 ]; then
        return 0
    fi

    local pkgs
    pkgs="$(printf '%s\n' "${mapped[@]}" 2>/dev/null | sort -u)"
    if command -v dpkg >/dev/null 2>&1; then
        die "omp-ui is missing system libraries this machine must provide.
Install them with your admin user, then re-run this installer:

  sudo apt install $(printf '%s\n' "$pkgs" | tr '\n' ' ' | sed 's/ $//')

Libraries: $(ldd "$bin" 2>/dev/null | awk '/not found/ {print $1}' | sort -u | tr '\n' ' ')"
    else
        die "omp-ui is missing system libraries this machine must provide
(install the package that provides each, then re-run this installer):

$(printf '%s\n' "${mapped[@]}" "${unmapped[@]}" 2>/dev/null | sort -u | sed 's/^/  /')"
    fi
}

# .so name -> Debian/Ubuntu package. Table derived from ldd of the shipped
# Electron binary (packages/desktop devDependency). Targets Ubuntu 24.04+
# (t64 names); on older releases the same packages exist without the t64 suffix.
so_to_package() {
    case "$1" in
        libnss3.so|libnssutil3.so|libsmime3.so|libplc4.so|libplds4.so) echo libnss3 ;;
        libnspr4.so) echo libnspr4 ;;
        libatk-1.0.so.0) echo libatk1.0-0t64 ;;
        libatk-bridge-2.0.so.0) echo libatk-bridge2.0-0t64 ;;
        libatspi.so.0) echo libatspi2.0-0t64 ;;
        libcups.so.2) echo libcups2t64 ;;
        libdbus-1.so.3) echo libdbus-1-3 ;;
        libcairo.so.2|libcairo-gobject.so.2) echo libcairo2 ;;
        libgdk-3.so.0|libgtk-3.so.0) echo libgtk-3-0t64 ;;
        libgdk_pixbuf-2.0.so.0) echo libgdk-pixbuf-2.0-0 ;;
        libpango-1.0.so.0) echo libpango-1.0-0 ;;
        libpangocairo-1.0.so.0) echo libpangocairo-1.0-0 ;;
        libpangoft2-1.0.so.0) echo libpangoft2-1.0-0 ;;
        libglib-2.0.so.0|libgobject-2.0.so.0|libgio-2.0.so.0|libgmodule-2.0.so.0) echo libglib2.0-0t64 ;;
        libX11.so.6) echo libx11-6 ;;
        libXext.so.6) echo libxext6 ;;
        libXfixes.so.3) echo libxfixes3 ;;
        libXcomposite.so.1) echo libxcomposite1 ;;
        libXdamage.so.1) echo libxdamage1 ;;
        libXrandr.so.2) echo libxrandr2 ;;
        libXrender.so.1) echo libxrender1 ;;
        libXi.so.6) echo libxi6 ;;
        libXcursor.so.1) echo libxcursor1 ;;
        libXinerama.so.1) echo libxinerama1 ;;
        libXau.so.6) echo libxau6 ;;
        libxcb.so.1) echo libxcb1 ;;
        libxcb-render.so.0) echo libxcb-render0 ;;
        libxcb-shm.so.0) echo libxcb-shm0 ;;
        libgbm.so.1) echo libgbm1 ;;
        libxkbcommon.so.0) echo libxkbcommon0 ;;
        libasound.so.2) echo libasound2t64 ;;
        libwayland-client.so.0) echo libwayland-client0 ;;
        libwayland-cursor.so.0) echo libwayland-cursor0 ;;
        libwayland-egl.so.1) echo libwayland-egl1 ;;
        libepoxy.so.0) echo libepoxy0 ;;
        libdrm.so.2) echo libdrm2 ;;
        libudev.so.1) echo libudev1 ;;
        libexpat.so.1) echo libexpat1 ;;
        libfontconfig.so.1) echo libfontconfig1 ;;
        libfreetype.so.6) echo libfreetype6 ;;
        libpixman-1.so.0) echo libpixman-1-0 ;;
        libharfbuzz.so.0) echo libharfbuzz0b ;;
        libfribidi.so.0) echo libfribidi0 ;;
        libthai.so.0) echo libthai0 ;;
        libdatrie.so.1) echo libdatrie1 ;;
        libgraphite2.so.3) echo libgraphite2-3 ;;
        liblcms2.so.2) echo liblcms2-2 ;;
        libpng16.so.16) echo libpng16-16 ;;
        libxml2.so.2) echo libxml2 ;;
        libselinux.so.1) echo libselinux1 ;;
        libseccomp.so.2) echo libseccomp2 ;;
        libsystemd.so.0) echo libsystemd0 ;;
        libavahi-common.so.3) echo libavahi-common3 ;;
        libavahi-client.so.3) echo libavahi-client3 ;;
        libgnutls.so.30) echo libgnutls30t64 ;;
        libp11-kit.so.0) echo libp11-kit0 ;;
        libidn2.so.0) echo libidn2-0 ;;
        libunistring.so.5) echo libunistring5 ;;
        libtasn1.so.6) echo libtasn1-6 ;;
        libnettle.so.8) echo libnettle8 ;;
        libhogweed.so.6) echo libhogweed6 ;;
        libgmp.so.10) echo libgmp10 ;;
        libcrypto.so.3|libssl.so.3) echo libssl3t64 ;;
        libkrb5.so.3|libk5crypto.so.3|libkrb5support.so.0|libgssapi_krb5.so.2) echo libkrb5-3 ;;
        libcom_err.so.2) echo libcom-err2 ;;
        libkeyutils.so.1) echo libkeyutils1 ;;
        libjson-glib-1.0.so.0) echo libjson-glib-1.0-0 ;;
        libtinysparql-3.0.so.0) echo libtinysparql-3.0-0 ;;
        libcloudproviders.so.0) echo libcloudproviders0 ;;
        libglycin-2.so.0) echo libglycin2 ;;
        libsqlite3.so.0) echo libsqlite3-0 ;;
        libffi.so.8) echo libffi8 ;;
        libpcre2-8.so.0) echo libpcre2-8-0 ;;
        libcap.so.2) echo libcap2 ;;
        libmount.so.1) echo libmount1 ;;
        libblkid.so.1) echo libblkid1 ;;
        libz.so.1) echo zlib1g ;;
        libbz2.so.1) echo libbz2-1.0 ;;
        liblzma.so.5) echo liblzma5 ;;
        libbrotlidec.so.1|libbrotlicommon.so.1) echo libbrotli1 ;;
        *) echo "" ;;
    esac
}

# Copies icons from $1 (the AppImage extraction root) into the per-user
# hicolor tree. Icon failure is not fatal: the desktop entry is the hard
# requirement. An empty or missing root skips the install with a warning.
install_icons() {
    local root="$1"
    if [ -z "$root" ] || [ ! -d "$root" ]; then
        err "warning: no AppImage extraction root; skipping icon install"
        return 0
    fi

    # Remove owned icons from earlier installs so a repair converges to exactly
    # the current AppImage's icon set (ownership boundary: $APP_ID.* only, as
    # in do_uninstall).
    local stale
    for stale in "$HICOLOR_DIR"/*/apps/"$APP_ID".*; do
        [ -e "$stale" ] || continue
        rm -f -- "$stale"
    done

    local installed=0
    local src rest size name dest
    # electron-builder embeds the icon under the executable name (omp-ui), not
    # the desktop id; accept both, publish under $APP_ID.
    local exec_name
    exec_name="$(basename "$TARGET" .AppImage)"
    for src in "$root"/usr/share/icons/hicolor/*/apps/"$APP_ID".* \
               "$root"/usr/share/icons/hicolor/*/apps/"$exec_name".*; do
        [ -f "$src" ] || continue
        rest="${src#"$root"/usr/share/icons/hicolor/}"
        size="${rest%%/*}"
        name="$(basename "$src")"
        dest="$HICOLOR_DIR/$size/apps/$APP_ID.${name##*.}"
        if [ -e "$dest" ]; then
            continue
        fi
        mkdir -p "$HICOLOR_DIR/$size/apps"
        cp -- "$src" "$dest"
        chmod 0644 "$dest"
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

# The menu entry execs a per-user launcher rather than the AppImage
# directly: the AppImage's static runtime mounts via FUSE when the system
# provides /dev/fuse and a fusermount binary, and the launcher otherwise
# forces the runtime's extract-and-run mode, so the menu launch needs no
# FUSE setup at all.
write_launcher() {
    mkdir -p "$BIN_DIR"
    cat >"$LAUNCHER" <<'EOF'
#!/usr/bin/env bash
# omp-ui launcher, installed by packaging/install.sh.
# Launches the omp-ui AppImage that sits beside this launcher, using a
# FUSE mount when the system provides /dev/fuse and a fusermount binary.
# Otherwise it forces the AppImage runtime's extract-and-run mode, so
# omp-ui launches without any FUSE setup.
set -euo pipefail
APPIMAGE="$(dirname "$(readlink -f "$0")")/omp-ui.AppImage"
if [ ! -f "$APPIMAGE" ]; then
    echo "omp-ui: $APPIMAGE not found; re-run the installer" >&2
    exit 1
fi
if [ -e /dev/fuse ] && { command -v fusermount3 >/dev/null 2>&1 || command -v fusermount >/dev/null 2>&1; }; then
    exec "$APPIMAGE" "$@"
else
    exec env APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGE" "$@"
fi
EOF
    chmod 0755 "$LAUNCHER"
}

# The desktop spec does not expand ~, so Exec carries the absolute path.
write_desktop_entry() {
    mkdir -p "$APPLICATIONS_DIR"
    cat >"$DESKTOP_FILE" <<EOF
[Desktop Entry]
Name=omp-ui
Comment=Desktop GUI for the omp coding agent
Exec=$LAUNCHER %U
Icon=$APP_ID
Type=Application
Categories=Development;
Terminal=false
StartupWMClass=$APP_ID
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
    require_x64

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

    # Extract once from the staged file so the prerequisite check and the
    # icon install share a single extraction. Tolerate failure (pre-existing
    # behavior for icon extraction): skip the dependent steps with a warning
    # rather than abort.
    local extract_root=""
    local extract_dir="$WORKDIR/extract"
    mkdir -p "$extract_dir"
    if (cd "$extract_dir" && "$staged_appimage" --appimage-extract >/dev/null 2>&1) \
        && [ -d "$extract_dir/squashfs-root" ]; then
        extract_root="$extract_dir/squashfs-root"
    else
        err "warning: could not extract the AppImage for the prerequisite check and icons"
    fi

    [ -z "$extract_root" ] || check_prerequisites "$extract_root"

    install_appimage "$staged_appimage"
    write_launcher
    if [ -n "$extract_root" ]; then
        install_icons "$extract_root"
    else
        install_icons ""
    fi
    write_desktop_entry
    refresh_caches

    printf 'omp-ui installed: %s\n' "$TARGET"
    printf 'Launch omp-ui from the application menu, or run: %s\n' "$LAUNCHER"
}

do_uninstall() {
    local purge="$1"
    local found=0

    if [ -e "$TARGET" ]; then
        rm -f -- "$TARGET"
        found=1
    fi
    if [ -e "$LAUNCHER" ]; then
        rm -f -- "$LAUNCHER"
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
