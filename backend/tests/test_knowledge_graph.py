"""Regression tests for the three extraction rules that were producing wrong edges:
the invented process hierarchy, unbounded system keyword matching, and entities that
only ever appear in a filename.

Run: python backend/tests/test_knowledge_graph.py      (reads the corpus and the BPML process house document).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.graph import knowledge_graph as kg  # noqa: E402

G = kg.extract_graph()
NODES = {n["id"]: n for n in G["nodes"]}
EDGES = G["edges"]


def edges(relation):
    return [e for e in EDGES if e["relation"] == relation]


def has_edge(src, tgt, relation):
    return any(e["source"] == src and e["target"] == tgt and e["relation"] == relation for e in EDGES)


# --- the process hierarchy comes from the BPML hierarchy, not from string splitting ---

def test_every_subprocess_edge_is_backed_by_the_bpml_hierarchy():
    known = kg.load_bpml_hierarchy()["name"]
    unverified = [
        e for e in edges("subprocess_of")
        if e["source"][5:] not in known or e["target"][5:] not in known
    ]
    assert not unverified, f"{len(unverified)} subprocess_of edges cite a code absent from BPML"


def test_the_invented_letter_parents_are_gone():
    # "O-030-010".rsplit("-", 1) used to yield a parent "O-030" that exists nowhere.
    for invented in ("O-030", "O-020", "O-050", "O-140", "DM-270", "P-080", "X-030"):
        assert f"proc:{invented}" not in NODES, f"{invented} is not a real BPML process"


def test_a_process_points_at_its_real_numbered_parent():
    # The BPML hierarchy puts O-030-010 Identify Order inside 4.5.2.4.
    assert has_edge("proc:O-030-010", "proc:4.5.2.4", "subprocess_of")
    assert NODES["proc:4.5.2.4"]["description"] == "Validate/ Perform Order Readiness"


def test_the_ancestry_walks_up_to_the_value_chain():
    chain, node = [], "proc:O-030-010"
    while True:
        up = [e["target"] for e in edges("subprocess_of") if e["source"] == node]
        if not up:
            break
        node = up[0]
        chain.append(NODES[node]["code"])
    assert chain == ["4.5.2.4", "4.5.2", "4.5", "4.0"]


def test_a_code_missing_from_the_hierarchy_gets_no_invented_parent():
    # O-160-030 is named in a document but is not in the BPML export.
    assert "proc:O-160-030" in NODES
    assert NODES["proc:O-160-030"]["in_bpml"] is False
    assert not [e for e in edges("subprocess_of") if e["source"] == "proc:O-160-030"]


def test_processes_carry_their_official_name():
    assert NODES["proc:O-050-010"]["description"] == "Check Credit Rating and Limits"
    assert NODES["proc:DC-030-210"]["description"] == "Perform Intercompany Reconciliation"


def test_a_longer_prefix_is_not_truncated_into_a_new_code():
    # The corpus says "INT-P-080-160"; reading that as "P-080-160" invents a process.
    assert "proc:P-080-160" not in NODES


# --- system fingerprints are word-bounded -------------------------------------

def test_a_customer_name_does_not_link_a_document_to_ecc():
    # This spreadsheet's only "ECC" runs are ADECCO, DECCAN, ELETTROMECCANIC, TECCEM.
    doc = "doc:20260109_SPARK_L2C_Corporate Group CRM  and SAP 20251125_xlsx.md"
    assert not has_edge(doc, "system:ECC", "mentions_system")


def test_an_export_control_acronym_does_not_link_a_document_to_ecc():
    # "ECCN" (Export Control Classification Number) is not SAP ECC.
    assert not has_edge("doc:SPARK L2C L1-L4 Processes _xlsx.md", "system:ECC", "mentions_system")


def test_a_salesforce_record_id_does_not_link_a_document_to_s4hana():
    # The only "S4" in this file is inside the id 001d100000DpgS4.
    doc = "doc:20260109_SPARK_L2C_Corporate Group CRM  and SAP 20251125_xlsx.md"
    assert not has_edge(doc, "system:S4HANA", "mentions_system")


def test_a_product_name_does_not_link_a_document_to_s4hana():
    # "SOPROPHOR S40 FLAKES" is a product, and the file never mentions HANA.
    doc = "doc:Solvay@eCommerce - Customer User Guide_pptx.md"
    assert not has_edge(doc, "system:S4HANA", "mentions_system")


def test_system_matching_is_case_insensitive():
    # Written "Sovos", which the old two-variant substring test missed.
    doc = "doc:L2C Trainings - Topics to add in details_pptx.md"
    assert has_edge(doc, "system:SOVOS", "mentions_system")


def test_ecommerce_is_matched_however_it_is_spelled():
    for doc, in_text in (
        ("doc:20251031_SPARK_L2C_SPARK_FS_Enhancement_L2C_21999_CMIR & Master Data Priority on Ship-to_docx.md", "E-commerce"),
        ("doc:Interim L2C W1_xlsx.md", "E Commerce"),
        ("doc:20260203_SPARK_L2C_Ecommerce_xlsx.md", "Ecommerce"),
    ):
        assert has_edge(doc, "system:eCommerce", "mentions_system"), f"missed {in_text}"


# --- filenames are searched too -----------------------------------------------

def test_a_ticket_named_only_in_the_filename_is_still_found():
    # SPARK-51136 - ATP and TRS check.docx never repeats its ticket in the body.
    assert "spec:SPARK-51136" in NODES
    assert has_edge("doc:SPARK-51136 - ATP and TRS check_docx.md", "spec:SPARK-51136", "implements_ticket")


def test_the_house_filename_styles_are_recognised_as_primary():
    for doc, ticket in (
        ("doc:SPARK_FS_L2C-21266-Process Receivable CollectionsWorklist_docx.md", "SPARK-21266"),
        ("doc:SPARK_FS_L2C_SPARK -22234-FS_Interface - SOVOS_docx.md", "SPARK-22234"),
        ("doc:SPARK_FS_L2C_21930_ Item Line Delivery Block Part 1_docx.md", "SPARK-21930"),
    ):
        assert has_edge(doc, f"spec:{ticket}", "implements_ticket"), f"{ticket} not primary"


def test_a_stream_named_late_in_a_document_is_still_found():
    # billing_form_translations names L2C 54 times, none within the first 600 chars.
    assert has_edge("doc:billing_form_translations_html.md", "stream:L2C", "belongs_to")


def test_a_stream_inside_an_sap_field_name_is_found():
    # The only L2C here is the field prefix ZZ1_L2C_SP21175_CODICECIG.
    assert has_edge("doc:Manage Text Labels for Billing Form_xlsx.md", "stream:L2C", "belongs_to")


def test_every_stream_now_carries_documents():
    for sid in ("L2C", "I2D", "R2R", "P2P"):
        assert NODES[f"stream:{sid}"]["degree"] > 0, f"{sid} has no documents"


def test_the_graph_is_reproducible():
    import json

    a = kg.extract_graph(force=True)
    b = kg.extract_graph(force=True)
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


# --- the register's Lowest Level Key is a property, not an entity -------------


def test_no_register_key_is_a_spec_node():
    # The register's key column names process steps. Ingesting it as entities
    # made 502 of 549 spec nodes -- and 502 of 556 ticket edges -- artefacts of
    # one spreadsheet, burying the 47 real functional specs.
    keys = kg.load_process_register()["keys"]
    tickets = {n["ticket"] for n in G["nodes"] if n["type"] == "spec"}
    assert keys, "the register should not be empty"
    assert not (tickets & keys), sorted(tickets & keys)[:5]


def test_every_lead_to_cash_step_carries_its_register_key():
    register = kg.load_process_register()["steps"]
    assert register, "no Lead-to-Cash steps were read"
    for code, step in register.items():
        node = NODES.get(f"proc:{code}")
        assert node is not None, f"step {code} has no node"
        assert node["jira_key"] == step["jira_key"], code


def test_a_register_step_still_reaches_its_value_chain():
    parent = {e["source"]: e["target"] for e in edges("subprocess_of")}
    node, chain = "proc:4.10.2.1", []
    while node in parent:
        node = parent[node]
        chain.append(node.split(":", 1)[1])
    assert chain == ["4.10.2", "4.10", "4.0"], chain


def test_the_register_document_is_no_longer_the_largest_node():
    register = next(n for n in G["nodes"] if "L1-L4 Processes" in n["id"])
    biggest = max(G["nodes"], key=lambda n: n.get("degree", 0))
    assert register["id"] != biggest["id"]
    assert register["degree"] < 50, register["degree"]


# --- the system list the design brief names ----------------------------------

BRIEF_SYSTEMS = {"S4HANA", "ECC", "WP1", "PF1", "M3", "Salesforce", "ESKER", "Elemica",
                 "SOVOS", "Coface", "CPI", "eCommerce", "OMP", "SAPTM", "EWM", "GTS", "MDG"}


def test_every_system_the_brief_names_has_a_node():
    have = {n["code"] for n in G["nodes"] if n["type"] == "system"}
    assert BRIEF_SYSTEMS <= have, sorted(BRIEF_SYSTEMS - have)


def test_every_system_pattern_has_a_label_and_a_kind():
    assert set(kg.SYSTEMS) == set(kg.SYSTEM_RE) == set(kg.SYSTEM_KIND)


def test_a_cubic_metre_is_not_the_m3_erp():
    # "m3" is a unit before it is an ERP, so that pattern stays case-sensitive.
    assert not kg.SYSTEM_RE["M3"].search("volume 12 m3 per batch")
    assert kg.SYSTEM_RE["M3"].search("removal of M3 orders management")


def test_the_short_system_acronyms_stay_word_bounded():
    for code, text in [("CPI", "principal"), ("GTS", "rights"), ("EWM", "renewmat"),
                       ("WP1", "SWP12"), ("OMP", "company")]:
        assert not kg.SYSTEM_RE[code].search(text), f"{code} matched inside {text!r}"


def test_a_legacy_instance_mention_links_the_document():
    assert any(e["target"] == "system:PF1" for e in EDGES)
    assert any(e["target"] == "system:ESKER" for e in EDGES)


# --- the model: one meaning per relationship type, evidence on relationships,
# --- a passage layer, and no presentation in the stored data ------------------

RAW = __import__("json").loads(kg.CACHE_FILE.read_text())


def test_a_document_mentioning_a_system_has_one_relationship_type():
    """The verb used to be picked by which system it was -- every S/4HANA link
    `runs_on`, every SOVOS link `interfaces_with` -- whatever the text said."""
    rels = {e["relation"] for e in EDGES if e["target"].startswith("system:")}
    assert rels == {"mentions_system"}, rels
    assert {n["id"]: n.get("kind") for n in G["nodes"] if n["type"] == "system"}["system:CPI"] == "middleware"


def test_every_document_relationship_says_where_it_came_from():
    for e in EDGES:
        if not e["source"].startswith("doc:"):
            continue
        assert e.get("method") and e.get("mentions", 0) >= 1, e["id"]
        assert len(e["chunks"]) == min(e["chunk_count"], kg.EDGE_CHUNKS), e["id"]


def test_the_chunks_on_a_relationship_really_mention_its_target():
    """A chunk key on an edge must point at a passage that names the entity --
    checked against the text retrieval serves, not against the graph's own
    bookkeeping."""
    from backend.rag import rag

    sample = [e for e in EDGES if e["relation"] == "mentions_system" and e["chunks"]][:25]
    assert sample
    for e in sample:
        code = e["target"].split(":", 1)[1]
        text = rag.chunk(e["chunks"][0])["content"].replace("_", " ")
        assert kg.SYSTEM_RE[code].search(text), (e["id"], e["chunks"][0])


def test_the_passage_layer_asserts_nothing_the_entity_layer_does_not():
    linked = {(e["source"], e["target"]) for e in EDGES if e["source"].startswith("doc:")}
    chunks = G["passages"]["nodes"]
    assert len(chunks) > 1000
    for c in chunks:
        for entity in c["mentions"]:
            assert (c["document"], entity) in linked, (c["id"], entity)


def test_the_property_graph_expands_chunks_into_relationships():
    nodes, rels = kg.property_graph(G)
    ids = {n["id"] for n in nodes}
    assert all(r["source"] in ids and r["target"] in ids for r in rels)
    kinds = {r["relation"] for r in rels}
    assert {"has_chunk", "mentions", "mentions_system"} <= kinds


def test_presentation_is_not_stored_and_a_document_keeps_its_size():
    """Degree, radius and colour are computed on load. The radius used to be
    written to `size` on top of the document's file size."""
    stored = {k for n in RAW["nodes"] for k in n}
    assert not {"degree", "size", "color"} & stored, stored & {"degree", "size", "color"}
    doc = next(n for n in RAW["nodes"] if n["type"] == "document")
    assert doc["bytes"] == (kg.BASE_DIR / doc["source"]).stat().st_size
    assert all("degree" in n and "size" in n and "color" in n for n in G["nodes"])


def test_a_category_filter_keeps_only_its_documents_chunks():
    sub = kg.filter_by_categories(G, ["DR"])
    docs = {n["id"] for n in sub["nodes"] if n["type"] == "document"}
    assert sub["passages"]["nodes"] and all(c["document"] in docs for c in sub["passages"]["nodes"])


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
