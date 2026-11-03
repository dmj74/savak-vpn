#!/usr/bin/env python3
"""
Resource / manifest / gradle cross-check for the Android module — stdlib only.

Why this exists: the first CI build of an Android app usually dies on something that has
nothing to do with logic — `R.string.foo` with no `foo`, a `proguard-rules.pro` that was
referenced but never written, a manifest component whose class moved. Each of those costs a
20-minute build cycle to discover. Every rule here is checkable in 30 ms with no SDK, so
`tools/typecheck.sh` and the `kotlin-port` CI job both run it before anything expensive.

It is a *reference graph* check, not a compiler: it cannot know whether a layout looks right.
"""

from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ANDROID_NS = "{http://schemas.android.com/apk/res/android}"
MOD = Path(__file__).resolve().parent.parent          # .../android
MAIN = MOD / "app" / "src" / "main"
RES = MAIN / "res"
KOTLIN_DIRS = [MAIN / "java"]

problems: list[str] = []


def fail(msg: str) -> None:
    problems.append(msg)


def kotlin_files() -> list[Path]:
    out: list[Path] = []
    for d in KOTLIN_DIRS:
        if d.is_dir():
            out += [p for p in d.rglob("*.kt") if "build" not in p.parts]
    return sorted(out)


# ── 1. what resources exist ──────────────────────────────────────────────────────────────
def defined_resources() -> dict[str, set[str]]:
    """type → names, exactly as aapt2 would see them."""
    have: dict[str, set[str]] = {}
    if not RES.is_dir():
        fail(f"no res directory at {RES}")
        return have
    for f in sorted(RES.iterdir()):
        if not f.is_dir():
            continue
        rtype = f.name.split("-", 1)[0]           # values-night → values
        if rtype == "values":
            for xml in f.glob("*.xml"):
                try:
                    root = ET.parse(xml).getroot()
                except ET.ParseError as e:
                    fail(f"res/{f.name}/{xml.name}: not parseable XML ({e})")
                    continue
                for child in root:
                    if child.tag in ("string", "string-array", "plurals", "color", "dimen",
                                     "integer", "bool", "integer-array", "array", "style"):
                        name = child.get(f"{ANDROID_NS}name") or child.get("name")
                        if name:
                            have.setdefault(child.tag, set()).add(name)
                    elif child.tag == "item":      # <item type="id" name="…">
                        t, n = child.get("type"), child.get(f"{ANDROID_NS}name")
                        if t and n:
                            have.setdefault(t, set()).add(n)
        elif rtype in ("drawable", "xml", "layout", "mipmap", "raw", "anim", "menu", "font"):
            for f2 in f.iterdir():
                if f2.is_file():
                    have.setdefault(rtype, set()).add(f2.stem)
    return have


# <style name="Theme.Savak"> is referenced as @style/Theme.Savak, and a `string` name may be
# used as an id too; keep the lookup permissive the way aapt2's is for these checks.
def resolves(defined: dict[str, set[str]], rtype: str, name: str) -> bool:
    if name in defined.get(rtype, set()):
        return True
    # @style/Theme.Foo.Suffix inherits from a declared parent — only the prefix must exist,
    # and a reference into the android: namespace (@android:style/…) is the framework's.
    if rtype == "style":
        for cand in defined.get("style", set()):
            if name.startswith(cand + "."):
                return True
    return False


# ── 2. Kotlin → R.* ───────────────────────────────────────────────────────────────────────
def check_kotlin_refs(defined: dict[str, set[str]]) -> None:
    pat = re.compile(r"\bR\.(?P<type>[a-z][a-z0-9_]*)\.(?P<name>[A-Za-z0-9_]+)")
    for path in kotlin_files():
        text = path.read_text(encoding="utf-8")
        for m in pat.finditer(text):
            rtype, name = m.group("type"), m.group("name")
            if rtype in ("id", "string", "drawable", "layout", "style", "color", "dimen",
                         "xml", "mipmap", "raw", "array", "plurals", "integer", "bool", "menu",
                         "font"):
                if not resolves(defined, rtype, name):
                    line = text[:m.start()].count("\n") + 1
                    fail(f"{path.relative_to(MOD)}:{line}: R.{rtype}.{name} has no matching "
                         f"entry under res/ — aapt2 will not generate that field")
    return None


# ── 3. XML (@string/… , @drawable/…) ──────────────────────────────────────────────────────
def check_xml_refs(defined: dict[str, set[str]]) -> None:
    pat = re.compile(r"@(?!\+)(?:(?P<ns>[A-Za-z0-9_.]+):)?(?P<type>[a-z]+)/(?P<name>[A-Za-z0-9_.]+)")
    targets = [MAIN / "AndroidManifest.xml"]
    if RES.is_dir():
        targets += [p for p in RES.rglob("*.xml") if p.is_file()]
    for path in targets:
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        for m in pat.finditer(text):
            if m.group("ns"):                       # @android:… is the framework's, always fine
                continue
            rtype, name = m.group("type"), m.group("name")
            if rtype in ("string", "drawable", "layout", "style", "color", "dimen", "xml",
                         "mipmap", "raw", "array", "plurals", "integer", "bool", "menu", "font",
                         "id"):
                # Style names contain dots for real (Theme.Savak), so no splitting here —
                # only the inheritance suffix is handled, in resolves().
                if not resolves(defined, rtype, name):
                    line = text[:m.start()].count("\n") + 1
                    fail(f"{path.relative_to(MOD)}:{line}: @{rtype}/{name} is not defined "
                         f"under res/ (and not a framework resource)")


# ── 4. manifest classes ────────────────────────────────────────────────────────────────────
def check_manifest_classes() -> None:
    manifest = MAIN / "AndroidManifest.xml"
    if not manifest.is_file():
        fail("app/src/main/AndroidManifest.xml missing")
        return
    root = ET.parse(manifest).getroot()
    pkg = root.get("package") or ""
    ns = (MOD / "app" / "build.gradle.kts").read_text(encoding="utf-8")
    m = re.search(r'namespace\s*=\s*"([^"]+)"', ns)
    pkg = pkg or (m.group(1) if m else "")
    if not pkg:
        fail("cannot determine the app package (manifest package= or build.gradle.kts namespace=)")
        return
    classes: dict[str, bool] = {}
    for tag in ("activity", "service", "receiver", "provider", "application"):
        for el in root.iter(tag):
            for attr in ("android:name", "android:targetActivity"):
                cls = el.get(f"{ANDROID_NS}name" if attr.startswith("android:") else attr)
                if attr != "android:name" or not cls:
                    continue
                classes[cls] = True
    for cls in sorted(classes):
        if not cls or "." not in cls and not cls.startswith("."):
            continue
        fq = cls if not cls.startswith(".") else f"{pkg}{cls}"
        rel = fq.replace(".", "/") + ".kt"
        if not (MAIN / "java" / rel).is_file():
            fail(f"manifest declares {cls!r} → expected {rel} under app/src/main/java/, not found")


# ── 5. files the gradle scripts say exist ──────────────────────────────────────────────────
def check_gradle_promises() -> None:
    app = MOD / "app" / "build.gradle.kts"
    if not app.is_file():
        fail("app/build.gradle.kts missing")
        return
    text = app.read_text(encoding="utf-8")
    for m in re.finditer(r'"([\w.\-]+\.pro)"', text):
        name = m.group(1)
        if not ((MOD / "app" / name).is_file() or (MOD / name).is_file()):
            fail(f"app/build.gradle.kts references {name} which does not exist — AGP fails "
                 f"before compiling anything")
    # Every library the sources import must be declared, or the build dies in unresolved refs.
    declared = " ".join(re.findall(r'"((?:com\.|androidx\.|org\.|io\.|net\.)[^"]*)"', text))
    groups = {
        "androidx.compose": "androidx.compose",
        "androidx.activity": "androidx.activity",
        "androidx.lifecycle": "androidx.lifecycle",
        "androidx.core": "androidx.core",
        "androidx.security": "androidx.security",
        "kotlinx.coroutines": "kotlinx-coroutines",
        "org.json": "org.json",
    }
    imported: dict[str, set[str]] = {}
    for path in kotlin_files():
        for line in path.read_text(encoding="utf-8").splitlines():
            m = re.match(r"\s*import\s+(androidx[.\w]*|kotlinx\.[.\w]*|org\.json[.\w]*)", line)
            if m:
                imported.setdefault(m.group(1), set()).add(path.name)
    for imp, files in sorted(imported.items()):
        for marker, needle in groups.items():
            if imp.startswith(marker.rstrip(".")) and needle not in declared:
                fail(f"{', '.join(sorted(files))}: imports {imp} but app/build.gradle.kts "
                     f"declares no {needle!r} dependency")
    # An unused dependency is not an error, but security-crypto pulls Tink in for nothing.
    used = " ".join(p.read_text(encoding="utf-8") for p in kotlin_files())
    for needle, why in (("androidx.security:security-crypto", "androidx.security.crypto"),
                        ("kotlinx-coroutines-android", "kotlinx.coroutines"),
                        ("activity-compose", "androidx.activity.compose"),
                        ("lifecycle-runtime-compose", "androidx.lifecycle")):
        if needle in declared and why not in used:
            fail(f"app/build.gradle.kts depends on {needle} but no source imports {why} — "
                 f"either use it or drop it (an unused artifact is APK size plus a CVE surface)")


def main() -> int:
    if not MOD.is_dir():
        print(f"run me from the repo (looking for {MOD})", file=sys.stderr)
        return 2
    defined = defined_resources()
    check_kotlin_refs(defined)
    check_xml_refs(defined)
    check_manifest_classes()
    check_gradle_promises()
    counts = ", ".join(f"{k}:{len(v)}" for k, v in sorted(defined.items()))
    print(f"resources: {counts} · kotlin files: {len(kotlin_files())}")
    if problems:
        print(f"resource/manifest cross-check FAILED — {len(problems)} problem(s):", file=sys.stderr)
        for p in problems:
            print(f"  · {p}", file=sys.stderr)
        return 1
    print("resource/manifest/gradle cross-check OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
