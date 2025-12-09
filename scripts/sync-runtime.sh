#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_RUNTIME_ROOT="/home/openvscode-server"
SKIP_BUNDLE=""
# По умолчанию падаем при ошибке бандла; отключить можно SYNC_RUNTIME_STRICT_BUNDLE=0
STRICT_BUNDLE="${SYNC_RUNTIME_STRICT_BUNDLE:-1}"
RUNTIME_COMMIT=""

usage() {
	cat <<'EOF' >&2
Usage: scripts/sync-runtime.sh [--runtime-root <path>] <relative-path> [<relative-path> ...]

Sync a changed source file into local out/out-build and the runtime mirrors under
/home/openvscode-server/{out,static/out,oss-*/static/out}. TypeScript files are
incrementally transpiled (esbuild) before syncing; bundled entrypoints are rebuilt
when the touched module belongs to a known bundle.
EOF
}

log() {
	printf '[sync-runtime] %s\n' "$*" >&2
}

warn() {
	printf '[sync-runtime][warn] %s\n' "$*" >&2
}

die() {
	printf '[sync-runtime][error] %s\n' "$*" >&2
	exit 1
}

RUNTIME_ROOT="${OPENVSCODE_RUNTIME_ROOT:-$DEFAULT_RUNTIME_ROOT}"
declare -a INPUT_PATHS=()
bundle_candidates=false
if [[ -n "$SKIP_BUNDLE" ]]; then
	log "bundle step disabled by SYNC_RUNTIME_SKIP_BUNDLE"
fi

while [[ $# -gt 0 ]]; do
	case "$1" in
		--runtime-root)
			[[ $# -lt 2 ]] && die "--runtime-root requires a value"
			RUNTIME_ROOT="$2"
			shift 2
			;;
		--runtime-root=*)
			RUNTIME_ROOT="${1#*=}"
			shift
			;;
		-h|--help)
			usage
			exit 0
			;;
		--)
			shift
			INPUT_PATHS+=("$@")
			break
			;;
		*)
			INPUT_PATHS+=("$1")
			shift
			;;
	esac
done

if [[ ${#INPUT_PATHS[@]} -eq 0 ]]; then
	usage
	exit 1
fi

# Detect runtime commit from product.json (runtime root preferred, fallback to repo)
detect_runtime_commit() {
		local candidate
		for candidate in "$RUNTIME_ROOT/product.json" "$ROOT/product.json" "$ROOT/static/product.json"; do
			if [[ -f "$candidate" ]]; then
				RUNTIME_COMMIT=$(node -e 'const fs=require("fs");const p=process.argv[1];try{const d=JSON.parse(fs.readFileSync(p,"utf8"));if(d && typeof d.commit==="string" && d.commit.trim())console.log(d.commit.trim());}catch{}' "$candidate")
				if [[ -n "$RUNTIME_COMMIT" ]]; then
					break
				fi
			fi
		done
	if [[ -n "$RUNTIME_COMMIT" ]]; then
		log "runtime commit detected: $RUNTIME_COMMIT"
	fi
}

detect_runtime_commit

RUNTIME_ROOT="${RUNTIME_ROOT%/}"
[[ -d "$RUNTIME_ROOT" ]] || warn "runtime root $RUNTIME_ROOT does not exist; will still write if directories become available"

# Capture existing oss-* slots up front to avoid creating new ones implicitly.
shopt -s nullglob
EXISTING_OSS_DIRS=()
for d in "$RUNTIME_ROOT"/oss-*; do
	[[ -d "$d" && -f "$d/product.json" ]] || continue
	EXISTING_OSS_DIRS+=("$d")
done
shopt -u nullglob

# Ensure commit oss slot exists.
add_oss_slot_if_missing() {
	local slot_name="$1"
	[[ -z "$slot_name" ]] && return
	local slot_path="$RUNTIME_ROOT/$slot_name"
	for existing in "${EXISTING_OSS_DIRS[@]}"; do
		[[ "$existing" == "$slot_path" ]] && return
	done
	if mkdir -p "$slot_path"; then
		if [[ -f "$RUNTIME_ROOT/product.json" && ! -f "$slot_path/product.json" ]]; then
			cp "$RUNTIME_ROOT/product.json" "$slot_path/product.json" || true
		fi
		EXISTING_OSS_DIRS+=("$slot_path")
		log "created oss slot $slot_path"
	fi
}

if [[ -n "$RUNTIME_COMMIT" ]]; then
	add_oss_slot_if_missing "oss-${RUNTIME_COMMIT}"
fi

declare -a SRC_TS_FILES=()
declare -a SRC_OTHER_FILES=()
declare -a PRECOMPILED_FILES=()

normalize_rel() {
	local path="$1"
	if [[ "$path" = /* ]]; then
		path="${path#$ROOT/}"
	fi
	path="${path#./}"
	echo "$path"
}

for raw in "${INPUT_PATHS[@]}"; do
	rel="$(normalize_rel "$raw")"
	abs="$ROOT/$rel"

	if [[ ! -e "$abs" ]]; then
		# allow runtime-sourced artifacts for out/static/out-build
		if [[ "$rel" == static/* || "$rel" == out/* || "$rel" == out-build/* ]]; then
			runtime_candidate="$RUNTIME_ROOT/$rel"
			if [[ -e "$runtime_candidate" ]]; then
				abs="$runtime_candidate"
			else
				alt_runtime_candidate="$RUNTIME_ROOT/${rel#static/}"
				if [[ -e "$alt_runtime_candidate" ]]; then
					abs="$alt_runtime_candidate"
					rel="${rel#static/}"
				else
					die "path does not exist: $rel"
				fi
			fi
		else
			die "path does not exist: $rel"
		fi
	fi

		case "$rel" in
			src/*)
				if [[ "$rel" == *.ts || "$rel" == *.tsx ]]; then
					SRC_TS_FILES+=("${rel#src/}")
					[[ -z "$SKIP_BUNDLE" ]] && bundle_candidates=true
				else
					SRC_OTHER_FILES+=("${rel#src/}")
					if [[ "$rel" == *.js || "$rel" == *.css ]]; then
						# plain preloader assets should not trigger full bundle rebuilds
						if [[ "$rel" == src/vs/workbench/contrib/webview/browser/pre/service-worker.js || "$rel" == src/vs/workbench/contrib/webview/browser/pre/index.html || "$rel" == src/vs/workbench/contrib/webview/browser/pre/fake.html ]]; then
							:
						else
						[[ -z "$SKIP_BUNDLE" ]] && bundle_candidates=true
						fi
					fi
				fi
				;;
			out/*|out-build/*|static/out/*)
				PRECOMPILED_FILES+=("$rel")
				;;
		*)
			warn "path $rel is outside src/out/static; attempting to sync relative to repository root"
			PRECOMPILED_FILES+=("$rel")
			;;
	esac
done

ensure_dirs() {
	for target in "$@"; do
		mkdir -p "$(dirname "$target")"
	done
}

add_destination_if_base_exists() {
	local target="$1"
	local base="$2"
	local rel="$3"
	if [[ ! -d "$base" ]]; then
		if mkdir -p "$base"; then
			log "created runtime base $base for $rel"
		else
			log "skip missing runtime base $base for $rel"
			return
		fi
	fi
	destinations+=("$target")
}

# Allow copying when the target already exists or when its parent directory is
# present in the runtime slot (avoids creating arbitrary new root slots while
# still letting new artifacts appear under existing slots).
should_sync_target() {
	local target="$1"
	local parent
	parent="$(dirname "$target")"
	if [[ -f "$target" ]]; then
		return 0
	fi
	if [[ "$target" == *"/oss-"* ]]; then
		return 0
	fi
	if [[ -d "$parent" ]]; then
		return 0
	fi
	return 1
}

write_file() {
	local path="$1"
	local content="$2"
	ensure_dirs "$path"
	printf '%s' "$content" >"$path"
}

# Compile TS/TSX files with esbuild and collect produced paths.
compile_ts_outputs() {
	[[ ${#SRC_TS_FILES[@]} -eq 0 ]] && return

	# Some server entrypoints must only be emitted via bundle (e.g. webClientServer).
	local -a skip_patterns=(
		"^vs/server/node/webClientServer\\."
	)

	local -a filtered=()
	for rel in "${SRC_TS_FILES[@]}"; do
		local matched=false
		for pat in "${skip_patterns[@]}"; do
			if [[ "$rel" =~ $pat ]]; then
				log "skip direct TS compile for $rel (bundle only)"
				matched=true
				break
			fi
		done
		[[ "$matched" == true ]] && continue
		filtered+=("$rel")
	done

	[[ ${#filtered[@]} -eq 0 ]] && return

	local list_json
	list_json="$(RUNTIME_ROOT_NODE="${RUNTIME_ROOT}" node - <<'NODE' "$ROOT" "${filtered[@]}"
const path = require('path');
const fs = require('fs/promises');
const esbuild = require('esbuild');

const root = process.argv[2];
const files = process.argv.slice(3);
const runtimeRoot = process.env.RUNTIME_ROOT_NODE || root;
const outDir = path.join(root, 'out');
const outBuildDir = path.join(root, 'out-build');
const tsconfig = path.join(root, 'src', 'tsconfig.json');

const normalizeRel = (p) => p.replace(/\\/g, '/');
const outputs = [];

const defaultHeader = [
	'/*!--------------------------------------------------------',
	' * Copyright (C) Microsoft Corporation. All rights reserved.',
	' *--------------------------------------------------------*/'
].join('\n');

const detectPlatform = (rel) => {
	if (rel.includes('/node/') || rel.startsWith('vs/server/') || rel.startsWith('bootstrap-') || rel.startsWith('server-')) {
		return 'node';
	}
	return 'neutral';
};

async function buildOne(rel) {
	const abs = path.join(root, 'src', rel);
	const platform = detectPlatform(rel);
	const result = await esbuild.build({
		entryPoints: [abs],
		bundle: false,
		format: 'esm',
		platform,
		target: 'es2022',
		tsconfig,
		outdir: outDir,
		outbase: path.join(root, 'src'),
		write: false,
		logLevel: 'silent'
	});

	for (const file of result.outputFiles) {
		const relOut = normalizeRel(path.relative(outDir, file.path));
		const outPath = path.join(outDir, relOut);
		const runtimeOut = path.join(runtimeRoot, 'out', relOut);
		const shouldWriteOut = await fs.access(outPath).then(() => true).catch(() => fs.access(runtimeOut).then(() => true).catch(() => false));
		if (shouldWriteOut) {
			await fs.mkdir(path.dirname(outPath), { recursive: true });
			await fs.writeFile(outPath, file.contents);
			outputs.push(`out/${relOut}`);
		}

		const outBuildPath = path.join(outBuildDir, relOut);
		const runtimeOutBuild = path.join(runtimeRoot, 'out-build', relOut);
		const shouldWriteOutBuild = await fs.access(outBuildPath).then(() => true).catch(() => fs.access(runtimeOutBuild).then(() => true).catch(() => false));
		if (shouldWriteOutBuild) {
			await fs.mkdir(path.dirname(outBuildPath), { recursive: true });
			await fs.writeFile(outBuildPath, file.contents);
			outputs.push(`out-build/${relOut}`);
		}
	}
}

(async () => {
	for (const rel of files) {
		await buildOne(rel);
	}
	console.log(JSON.stringify(outputs));
})().catch(err => {
	console.error('[sync-runtime] compile failed', err);
	process.exit(1);
});
NODE
)"

	local -a produced
	if [[ -n "$list_json" ]]; then
		mapfile -t produced < <(node - <<'NODE' "$list_json"
const data = process.argv[2];
try {
	const parsed = JSON.parse(data);
	for (const item of parsed) {
		console.log(item);
	}
} catch (err) {
	process.stderr.write('[sync-runtime] failed to parse compile output\n');
	process.exit(1);
}
NODE
)
	fi

	for rel in "${produced[@]:-}"; do
		[[ -n "$rel" ]] || continue
		PRECOMPILED_FILES+=("$rel")
	done
}

compile_ts_outputs

# Copy non-TS files from src to out/out-build
if [[ ${#SRC_OTHER_FILES[@]} -gt 0 ]]; then
	for rel in "${SRC_OTHER_FILES[@]}"; do
		src_path="$ROOT/src/$rel"
		out_path="$ROOT/out/$rel"
		out_build_path="$ROOT/out-build/$rel"
		ensure_dirs "$out_path" "$out_build_path"
		cp "$src_path" "$out_path"
		cp "$src_path" "$out_build_path"
		PRECOMPILED_FILES+=("out/$rel" "out-build/$rel")
	done
fi

# Determine bundles affected by the changes.
determine_bundles() {
	if [[ "${bundle_candidates}" != true ]]; then
		return
	fi
	[[ ${#SRC_TS_FILES[@]} -eq 0 && ${#SRC_OTHER_FILES[@]} -eq 0 ]] && return
	local bundle_list
	bundle_list="$(node - <<'NODE' "$ROOT" "${SRC_TS_FILES[@]}" "${SRC_OTHER_FILES[@]}"
const path = require('path');
const buildfile = require(path.join(process.argv[2], 'build', 'buildfile.js'));
const changed = process.argv.slice(3).map(p => p.replace(/\\/g, '/'));

const entryFrom = (name) => ({ name, platform: (name.includes('/node/') || name.startsWith('server-') || name.startsWith('bootstrap-')) ? 'node' : 'browser' });

const serverEntries = (buildfile.codeServer || []).map(e => entryFrom(e.name || e));
const webEntries = [
	...(buildfile.workerEditor ? [buildfile.workerEditor] : []),
	...(buildfile.workerExtensionHost ? [buildfile.workerExtensionHost] : []),
	...(buildfile.workerNotebook ? [buildfile.workerNotebook] : []),
	...(buildfile.workerLanguageDetection ? [buildfile.workerLanguageDetection] : []),
	...(buildfile.workerLocalFileSearch ? [buildfile.workerLocalFileSearch] : []),
	...(buildfile.workerProfileAnalysis ? [buildfile.workerProfileAnalysis] : []),
	...(buildfile.workerOutputLinks ? [buildfile.workerOutputLinks] : []),
	...(buildfile.workerBackgroundTokenization ? [buildfile.workerBackgroundTokenization] : []),
	...(buildfile.keyboardMaps || [])
].map(e => entryFrom(e.name || e));

const codeWeb = buildfile.codeWeb ? [entryFrom(buildfile.codeWeb.name || buildfile.codeWeb)] : [];
const workbenchWeb = buildfile.workbenchWeb ? [entryFrom(buildfile.workbenchWeb.name || buildfile.workbenchWeb)] : [];
const bootstrapEntries = ['server-main', 'server-cli', 'bootstrap-fork'].map(entryFrom);

const allEntries = new Map();
for (const group of [serverEntries, webEntries, codeWeb, workbenchWeb, bootstrapEntries]) {
	for (const item of group) {
		if (!item || !item.name) continue;
		allEntries.set(item.name, item);
	}
}

const selected = new Map();
const ensure = (name, platform) => {
	if (!name) return;
	const info = allEntries.get(name) || { name, platform: platform || (name.includes('/node/') ? 'node' : 'browser') };
	selected.set(info.name, info.platform);
};

const addServerBundles = () => {
	for (const entry of [...serverEntries, ...bootstrapEntries]) {
		ensure(entry.name, entry.platform);
	}
};

const addWebBundles = () => {
	for (const entry of [...codeWeb, ...workbenchWeb]) {
		ensure(entry.name, entry.platform);
	}
};

for (const rel of changed) {
	const bare = rel.replace(/\.(ts|tsx|js|css|html)$/, '');
	if (allEntries.has(bare)) {
		const entry = allEntries.get(bare);
		ensure(entry.name, entry.platform);
		continue;
	}

	if (rel.startsWith('vs/server/') || rel.startsWith('server-') || rel.includes('/node/')) {
		addServerBundles();
		continue;
	}

	if (rel.includes('extensionHostWorker')) {
		ensure('vs/workbench/api/worker/extensionHostWorkerMain', 'browser');
	}
	if (rel.includes('notebook')) {
		ensure('vs/workbench/contrib/notebook/common/services/notebookWebWorkerMain', 'browser');
	}
	if (rel.includes('languageDetection')) {
		ensure('vs/workbench/services/languageDetection/browser/languageDetectionWebWorkerMain', 'browser');
	}
	if (rel.includes('localFileSearch')) {
		ensure('vs/workbench/services/search/worker/localFileSearchMain', 'browser');
	}
	if (rel.includes('output') && rel.includes('worker')) {
		ensure('vs/workbench/contrib/output/common/outputLinkComputerMain', 'browser');
	}
	if (rel.includes('backgroundTokenization')) {
		ensure('vs/workbench/services/textMate/browser/backgroundTokenization/worker/textMateTokenizationWorker.workerMain', 'browser');
	}
	if (rel.includes('keyboardLayouts')) {
		ensure('vs/workbench/services/keybinding/browser/keyboardLayouts/layout.contribution.linux', 'browser');
		ensure('vs/workbench/services/keybinding/browser/keyboardLayouts/layout.contribution.darwin', 'browser');
		ensure('vs/workbench/services/keybinding/browser/keyboardLayouts/layout.contribution.win', 'browser');
	}
	if (rel.startsWith('vs/editor/')) {
		ensure('vs/editor/common/services/editorWebWorkerMain', 'browser');
	}

	if (rel.startsWith('vs/')) {
		addWebBundles();
		ensure('vs/workbench/api/worker/extensionHostWorkerMain', 'browser');
	}
}

for (const [name, platform] of selected.entries()) {
	console.log(`${name}|${platform}`);
}
NODE
)"

	local -a bundles
	if [[ -n "$bundle_list" ]]; then
		mapfile -t bundles <<<"$bundle_list"
	fi

	if [[ ${#bundles[@]} -eq 0 ]]; then
		return
	fi

	log "bundling ${#bundles[@]} entrypoint(s)"

	local bundle_outputs
	if ! bundle_outputs="$(node - <<'NODE' "$ROOT" "${bundles[@]}"
const path = require('path');
const fs = require('fs/promises');
const esbuild = require('esbuild');

const root = process.argv[2];
const entries = process.argv.slice(3);
const outDir = path.join(root, 'out');
const outBuildDir = path.join(root, 'out-build');
const tsconfig = path.join(root, 'src', 'tsconfig.json');

const defaultHeader = [
	'/*!--------------------------------------------------------',
	' * Copyright (C) Microsoft Corporation. All rights reserved.',
	' *--------------------------------------------------------*/'
].join('\n');

const normalizeRel = (p) => p.replace(/\\/g, '/');

const ensureSourcePath = (name) => {
	const candidates = [
		path.join(root, 'src', `${name}.ts`),
		path.join(root, 'src', `${name}.tsx`),
		path.join(root, 'src', `${name}.js`)
	];
	for (const candidate of candidates) {
		if (require('fs').existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
};

const outputs = [];

	async function bundleOne(raw) {
		const [name, explicitPlatform] = raw.split('|');
		const sourcePath = ensureSourcePath(name);
		if (!sourcePath) {
			console.error('[sync-runtime] skip bundle', name, '- source not found');
			return;
		}
		const platform = explicitPlatform || (name.includes('/node/') || name.startsWith('server-') ? 'node' : 'browser');
		const result = await esbuild.build({
			entryPoints: [{ in: sourcePath, out: name }],
			bundle: true,
			format: 'esm',
			platform,
			target: 'es2022',
			tsconfig,
			outdir: outDir,
			outbase: path.join(root, 'src'),
			write: false,
			logLevel: 'silent',
			packages: 'external',
			loader: {
				'.ttf': 'dataurl',
				'.otf': 'dataurl',
				'.woff': 'dataurl',
				'.woff2': 'dataurl',
				'.eot': 'dataurl',
				'.png': 'dataurl',
				'.jpg': 'dataurl',
				'.jpeg': 'dataurl',
				'.gif': 'dataurl',
				'.svg': 'dataurl',
				'.ico': 'dataurl'
			}
		});

		for (const file of result.outputFiles) {
			const relOut = normalizeRel(path.relative(outDir, file.path));
			const outPath = path.join(outDir, relOut);
			await fs.mkdir(path.dirname(outPath), { recursive: true });
			await fs.writeFile(outPath, file.contents);
			outputs.push(`out/${relOut}`);

			const outBuildPath = path.join(outBuildDir, relOut);
			await fs.mkdir(path.dirname(outBuildPath), { recursive: true });
			await fs.writeFile(outBuildPath, file.contents);
			outputs.push(`out-build/${relOut}`);
		}
	}

(async () => {
	for (const entry of entries) {
		await bundleOne(entry);
	}
	console.log(JSON.stringify(outputs));
})().catch(err => {
	console.error('[sync-runtime] bundle failed', err);
	process.exit(1);
});
NODE
)"
	then
		if [[ -n "$STRICT_BUNDLE" ]]; then
			die "bundle step failed"
		else
			warn "bundle step failed; continuing without bundled artifacts (set SYNC_RUNTIME_STRICT_BUNDLE=1 to fail hard)"
			bundle_outputs=""
		fi
	fi

	local -a bundle_paths
	if [[ -n "$bundle_outputs" ]]; then
		mapfile -t bundle_paths < <(node - <<'NODE' "$bundle_outputs"
const data = process.argv[2];
try {
	const parsed = JSON.parse(data);
	for (const item of parsed) {
		console.log(item);
	}
} catch (err) {
	process.stderr.write('[sync-runtime] failed to parse bundle output\n');
	process.exit(1);
}
NODE
)
	fi

	for rel in "${bundle_paths[@]:-}"; do
		[[ -n "$rel" ]] || continue
		PRECOMPILED_FILES+=("$rel")
	done
}

determine_bundles

declare -A DEST_TOUCH=()

copy_variant() {
	local rel="$1"
	# webClientServer.js всегда попадает в серверные бандлы (server-main/server-cli/bootstrap-fork),
	# прямое копирование не требуется и может путать рантайм путями.
	if [[ "$rel" == "out/vs/server/node/webClientServer.js" || "$rel" == "out-build/vs/server/node/webClientServer.js" ]]; then
		log "skip copy for $rel (served via bundled server-main/server-cli/bootstrap-fork)"
		return
	fi
	local src="$ROOT/$rel"

	if [[ ! -f "$src" ]]; then
		# fallback to runtime copies when the artifact is only in runtime (prebuilt)
		if [[ "$rel" == static/* || "$rel" == out/* || "$rel" == out-build/* ]]; then
			local runtime_src="$RUNTIME_ROOT/$rel"
			if [[ -f "$runtime_src" ]]; then
				src="$runtime_src"
			else
				local alt_runtime_src="$RUNTIME_ROOT/${rel#static/}"
				[[ -f "$alt_runtime_src" ]] && src="$alt_runtime_src"
			fi
		fi
	fi

	if [[ ! -f "$src" ]]; then
		warn "skip missing artifact $rel"
		return
	fi

	local destinations=()

	if [[ "$rel" == out/* ]]; then
		if should_sync_target "$RUNTIME_ROOT/$rel"; then destinations+=("$RUNTIME_ROOT/$rel"); fi
		if should_sync_target "$RUNTIME_ROOT/static/$rel"; then destinations+=("$RUNTIME_ROOT/static/$rel"); fi
		for slot in "${EXISTING_OSS_DIRS[@]}"; do
			if ! should_sync_target "$slot/static/$rel"; then
				continue
			fi
			destinations+=("$slot/static/$rel")
		done
	elif [[ "$rel" == static/out/* ]]; then
		if should_sync_target "$RUNTIME_ROOT/$rel"; then destinations+=("$RUNTIME_ROOT/$rel"); fi
		for slot in "${EXISTING_OSS_DIRS[@]}"; do
			if ! should_sync_target "$slot/$rel"; then
				continue
			fi
			destinations+=("$slot/$rel")
		done
	elif [[ "$rel" == out-build/* ]]; then
		local stripped="${rel#out-build/}"
		if should_sync_target "$RUNTIME_ROOT/static/out/$stripped"; then destinations+=("$RUNTIME_ROOT/static/out/$stripped"); fi
		for slot in "${EXISTING_OSS_DIRS[@]}"; do
			if ! should_sync_target "$slot/static/out/$stripped"; then
				continue
			fi
			destinations+=("$slot/static/out/$stripped")
		done
	else
		if should_sync_target "$RUNTIME_ROOT/$rel"; then destinations+=("$RUNTIME_ROOT/$rel"); fi
	fi

	for dest in "${destinations[@]}"; do
		local is_new_target=false
		[[ ! -f "$dest" ]] && is_new_target=true
		if [[ "$src" -ef "$dest" ]]; then
			log "skip copy (source == dest) for $dest"
			continue
		fi
		ensure_dirs "$dest"
		if cp "$src" "$dest" 2>/dev/null; then
			DEST_TOUCH["$dest"]=1
			if [[ "$is_new_target" == true ]]; then
				log "copied (new) $rel -> $dest"
			else
				log "copied $rel -> $dest"
			fi
			continue
		fi
		# fallback with sudo if destination is not writable
		if command -v sudo >/dev/null 2>&1; then
			if sudo cp "$src" "$dest"; then
				DEST_TOUCH["$dest"]=1
				log "copied (sudo) $rel -> $dest"
				continue
			fi
		fi
		warn "failed to copy $rel -> $dest"
	done
}

for rel in "${PRECOMPILED_FILES[@]}"; do
	copy_variant "$rel"
done

if (( ${#DEST_TOUCH[@]} )); then
	log "synchronized ${#DEST_TOUCH[@]} runtime file(s)"
fi
