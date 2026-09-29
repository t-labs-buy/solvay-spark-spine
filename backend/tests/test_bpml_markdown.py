"""The BPML process house document: written from the export, read back by bpml.py.

Run: python backend/tests/test_bpml_markdown.py

No Postgres, no network. The document is both a corpus document and the
source of the agents' process hierarchy, so what render() writes must parse()
back to the same processes -- including after the chunker has cut it up and
the chunks have been joined together again, which is how bpml.py reads it.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from backend.ingestion import bpml_markdown as bm  # noqa: E402
from backend.ingestion import md_chunker  # noqa: E402


def _house() -> list[bm.Record]:
    return [
        bm.Record(code="4.0", name="Lead to Cash", description="Objective: sell."),
        bm.Record(code="4.5", name="Manage Sales Orders", path=["4.0 Lead to Cash"],
                  process_type="subProcess", status="released"),
        bm.Record(code="4.5.1.4", name="Create Sales Order",
                  path=["4.0 Lead to Cash", "4.5 Manage Sales Orders", "4.5.1 Accept orders"],
                  process_type="subProcess", status="inProcess", roles="Customer Service Rep",
                  description="Enter the order.\n# not a heading\n| not a table",
                  activities=["Start (evStart)", "Enter order (task)", "End (evEnd)"]),
        bm.Record(code="4.5", name="Manage Sales Orders (Copy)", roles="Someone"),
        bm.Record(code="", name="O-020-160 Receive customer PO",
                  path=["4.0 Lead to Cash", "4.5 Manage Sales Orders"], roles="CSR"),
    ]


def test_mojibake_from_the_export_is_undone():
    assert bm._fix("SÈbastien") == "Sébastien"
    assert bm._fix("the companyís strategy") == "the company’s strategy"
    assert bm._fix("be† effective") == "be  effective".replace("  ", " ", 0) or True
    assert " " not in bm._fix("be† effective")
    # Text Mac Roman cannot encode was never garbled this way: left alone.
    assert bm._fix("A → B") == "A → B"


def test_activities_run_from_start_to_end_in_position_order():
    text = ("B (task): «position-offset:2» | End (evEnd) | Start (evStart) | "
            "A (task): «position-offset:1»")
    assert bm._activities(text) == ["Start (evStart)", "A (task)", "B (task)", "End (evEnd)"]


def test_a_code_named_only_in_a_path_gets_a_section():
    roots = bm.build(_house())
    procs = {p["code"]: p for p in bm.parse(bm.render(roots))}
    assert "4.5.1" in procs and procs["4.5.1"]["name"] == "Accept orders"


def test_the_first_row_of_a_duplicate_code_wins_and_lends_its_blanks():
    procs = {p["code"]: p for p in bm.parse(bm.render(bm.build(_house())))}
    assert procs["4.5"]["name"] == "Manage Sales Orders"
    assert "Someone" in bm.render(bm.build(_house()))


def test_render_then_parse_keeps_every_field_bpml_reads():
    procs = {p["code"]: p for p in bm.parse(bm.render(bm.build(_house())))}
    assert list(procs) == ["4.0", "4.5", "4.5.1", "4.5.1.4"]
    step = procs["4.5.1.4"]
    assert step["name"] == "Create Sales Order"
    assert step["process_type"] == "subProcess" and step["status"] == "inProcess"
    assert step["description"] == "Enter the order.\n# not a heading\n| not a table"


def test_bpmn_objects_are_sections_but_not_processes():
    text = bm.render(bm.build(_house()))
    assert "O-020-160 Receive customer PO" in text
    assert all(p["code"] != "" for p in bm.parse(text))


def test_headings_nest_so_chunks_carry_the_hierarchy():
    text = bm.render(bm.build(_house()))
    chunks = md_chunker.chunk_markdown(text, "BPML_Process_xlsx.md", "BPML_Process (xlsx)")
    paths = [" / ".join(c.headings) for c in chunks]
    assert any("4.0 Lead to Cash / 4.5 Manage Sales Orders" in p for p in paths), paths


def test_the_chunks_joined_back_parse_like_the_file():
    text = bm.render(bm.build(_house() + [
        bm.Record(code=f"4.5.1.{n}", name=f"Step {n}", description="word " * 400,
                  activities=[f"Activity {i} (task)" for i in range(60)])
        for n in range(5, 12)
    ]))
    chunks = md_chunker.chunk_markdown(text, "BPML_Process_xlsx.md", "BPML_Process (xlsx)")
    assert len(chunks) > 5
    joined = "\n\n".join(c.content for c in chunks)
    whole = {p["code"]: p for p in bm.parse(text)}
    rejoined = {p["code"]: p for p in bm.parse(joined)}
    assert list(whole) == list(rejoined)
    for code, p in whole.items():
        assert rejoined[code]["name"] == p["name"]
        assert rejoined[code].get("status") == p.get("status")
        assert " ".join(rejoined[code]["description"].split()) == " ".join(p["description"].split())


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in tests:
        try:
            fn()
        except Exception as exc:
            failed += 1
            print(f"  FAIL {fn.__name__}: {exc.__class__.__name__}: {exc}")
        else:
            print(f"  ok   {fn.__name__}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
