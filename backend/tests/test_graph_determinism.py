"""The knowledge graph build must be a pure function of ALL of its inputs.

Run: python backend/tests/test_graph_determinism.py

Same files in, same graph out -- not merely the same nodes and edges, but the
same bytes. That property is what makes a change to an extraction rule
reviewable: rebuild, diff, and the diff is exactly what the rule did.

It was lost for a while, and quietly. `extract_graph` iterated
`set(CODE_RE.findall(content))` and `set(TICKET_RE.findall(haystack))`
directly, so the order it created process and spec nodes in came from string
hashing, which Python seeds per process. Two builds of an unchanged corpus
produced identical content in a different order: same 2,389 nodes, same 4,780
edges, same stats, and a 38,000-line diff in a tracked file that said nothing
at all. Noise like that does not announce itself -- it just trains everyone to
stop reading the diff, which is where a real change would have been.

The check has to cross a process boundary, because PYTHONHASHSEED is fixed for
the life of an interpreter: building twice inside one process cannot fail even
when the bug is present.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BASE))

# Built with cache=False: the point is to compare two BUILDS, and a cache hit
# would compare one build with itself and pass regardless.
BUILD = """
import hashlib, json, sys
sys.path.insert(0, %r)
from backend.graph import knowledge_graph as kg
g = kg.extract_graph(force=True, cache=False)
print(hashlib.sha256(json.dumps(g).encode()).hexdigest())
print(json.dumps(g["stats"]["types"]))
"""


def build(seed: str) -> tuple[str, str]:
    """(digest, type counts) from a fresh interpreter with this hash seed."""
    out = subprocess.run(
        [sys.executable, "-c", BUILD % str(BASE)],
        capture_output=True, text=True, env={"PYTHONHASHSEED": seed, "PATH": "/usr/bin:/bin"},
        cwd=BASE, check=True,
    ).stdout.split("\n")
    return out[0].strip(), out[1].strip()


def test_two_builds_under_different_hash_seeds_are_byte_identical():
    a, types_a = build("1")
    b, types_b = build("2")
    assert types_a == types_b, f"the graph itself differs: {types_a} vs {types_b}"
    assert a == b, (
        "two builds of the same corpus produced different bytes.\n"
        f"  seed 1: {a[:16]}\n  seed 2: {b[:16]}\n"
        "Something in extract_graph iterates a set (or another unordered "
        "collection) and lets that reach the output. Sort it before iterating."
    )


def test_the_cached_graph_matches_a_fresh_build():
    """A served cache must be the graph a rebuild would produce.

    Otherwise the file on disk and the graph the agents traverse drift apart,
    and the one nobody rebuilt is the one being cited."""
    from backend.graph import knowledge_graph as kg

    fresh = kg.extract_graph(force=True, cache=False)
    cached = json.loads((BASE / "data" / "knowledge_graph.json").read_text())
    if cached.get("stats", {}).get("sources") != fresh["stats"]["sources"]:
        print("  skip  the cached graph was built from a different file set")
        return
    for key in ("total_nodes", "total_edges", "types", "categories"):
        assert cached["stats"][key] == fresh["stats"][key], (
            f"the cached graph disagrees with a fresh build on {key}: "
            f"{cached['stats'][key]} vs {fresh['stats'][key]}"
        )
    digest = lambda g: hashlib.sha256(  # noqa: E731
        json.dumps([n["id"] for n in g["nodes"]] + [e["id"] for e in g["edges"]]).encode()
    ).hexdigest()
    assert digest(cached) == digest(fresh), (
        "the cached graph holds the same nodes and edges in a different order, "
        "so every rebuild rewrites the file for no reason"
    )



# --- every input is fingerprinted ----------------------------------------------
#
# "Pure function of the corpus" is not enough: the process hierarchy is read
# from the BPML process house document, and the corpus files are fingerprinted
# by size, which correcting a process name can leave unchanged. While the
# fingerprint did not cover the hierarchy's source by content you
# could correct the process hierarchy, rebuild, and be served the
# graph built from the version you had just replaced, with no error anywhere.


def _document_copy(tmp: Path):
    """The builder pointed at a disposable copy of the process house document.

    The real one is never written to: a test that edits it is one interrupted
    run away from corrupting the source of every agent's scope."""
    import shutil
    from backend.graph import knowledge_graph as kg

    shutil.copy(kg.BPML_MD, tmp)
    original = kg.BPML_MD
    kg.BPML_MD = tmp
    kg._bpml_cache = kg._bpml_cache_key = None
    return kg, original


def _append_process(path: Path, label: str) -> None:
    with path.open("a", encoding="utf-8") as f:
        f.write(f"\n## {label}\n\n- **Level:** 2\n- **Path:** 9.0 Record to Report\n")


def test_editing_the_bpml_document_changes_the_fingerprint():
    tmp = Path("/tmp/kg_fingerprint_test.md")
    kg, original = _document_copy(tmp)
    try:
        files = kg.collect_files()
        before = kg._sources_fingerprint(files)
        _append_process(tmp, "9.9 Added By A Test")
        after = kg._sources_fingerprint(files)
        assert before != after, (
            "the document changed and the fingerprint did not, so a cached graph "
            "built from the old hierarchy is served as though it were current"
        )
    finally:
        kg.BPML_MD = original
        kg._bpml_cache = kg._bpml_cache_key = None
        tmp.unlink(missing_ok=True)


def test_a_live_process_reloads_the_hierarchy_when_the_document_changes():
    """The nastier half: force=True could not fix it.

    load_bpml_hierarchy cached into a module global and never looked at its
    source again, so a server running for days rebuilt every node from a
    hierarchy read before its source was corrected."""
    tmp = Path("/tmp/kg_cache_test.md")
    kg, original = _document_copy(tmp)
    try:
        before = kg.load_bpml_hierarchy()["name"]
        assert "9.9" not in before, "the fixture code is already in the document"
        _append_process(tmp, "9.9 Added By A Test")
        after = kg.load_bpml_hierarchy()["name"]
        assert "9.9" in after, (
            "the hierarchy is still the one loaded before the document changed; "
            "the module cache is not keyed on its source"
        )
        assert len(after) == len(before) + 1
    finally:
        kg.BPML_MD = original
        kg._bpml_cache = kg._bpml_cache_key = None
        tmp.unlink(missing_ok=True)


def test_a_missing_document_is_a_different_fingerprint_from_a_present_one():
    """Absent is a state too. Losing the document degrades the graph -- every
    process loses its parent chain -- and that must not be served from a cache
    built when it was there."""
    tmp = Path("/tmp/kg_missing_test.md")
    kg, original = _document_copy(tmp)
    try:
        files = kg.collect_files()
        present = kg._sources_fingerprint(files)
        tmp.unlink()
        absent = kg._sources_fingerprint(files)
        assert present != absent
    finally:
        kg.BPML_MD = original
        kg._bpml_cache = kg._bpml_cache_key = None
        tmp.unlink(missing_ok=True)


if __name__ == "__main__":
    import traceback

    fns = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in fns:
        try:
            fn()
            print(f"  ok   {name}")
        except Exception:
            failed += 1
            print(f"  FAIL {name}")
            traceback.print_exc()
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
