"""Generate local / SAP BTP / Azure architecture specs from the routed base spec."""
import json, copy, sys, os
sys.path.insert(0, os.path.expanduser("~/.claude/skills/component-arch-diagram/scripts"))
from relax import relax   # widen the gaps between boxes; boxes keep their size
docs = sys.argv[1]
base = json.load(open(f"{docs}/component-architecture.spec.json"))

def build(title, nodes, platform, legend, data_band=None):
    s = copy.deepcopy(base)
    s["title"] = title
    s["link_style"] = {"color": "#A3AAB4", "head": "open", "corners": "square", "width": 1.5}
    s["canvas"]["height"] = 1320
    for g in s["bands"] + s.get("groups", []):
        if g["name"] == "Model Serving": g["n"] = "8"
        if g["name"] == "External Services": g["n"] = "9"
        if data_band and g["name"].startswith("Data"): g["name"] = data_band
    s["bands"].append({"n": "7", "name": "Platform &\nDeployment", "x": 20, "y": 1080, "w": 1320, "h": 130})
    by_id = {n["id"]: n for n in s["nodes"]}
    for nid, upd in nodes.items():
        by_id[nid].update(upd)
    for i, (t, sub) in enumerate(platform):
        s["nodes"].append({"id": f"PLAT{i}", "title": t, "sub": sub, "kind": "ops", "cx": 330 + 280 * i, "cy": 1145})
    s["legend"] = {"box": {"x": 20, "y": 1230, "w": 1320}, "lines": legend}
    return s

COMMON_LEGEND = ["Arrows = request / data direction · an arrow to a layer = used by several of its parts",
                 "Dark boxes = managed / cloud services outside the app · green = data stores · band 7 = platform services used by every component"]

local = build(
    "Solvay Spark Spine AI — Current Architecture (Docker Compose, on-server)",
    {
        "AUTH": {"sub": "accounts · roles\n(Admin tab)"},
        "FILES": {"sub": "solvay-spark/ · knowledge_base/\nDocker volumes"},
        "MEM": {"sub": "agent memory (container)\nstored in Postgres"},
        "PG": {"title": "PostgreSQL 18", "sub": "pgvector · full-text\nscores · run history"},
        "OLLAMA": {"title": "Ollama (container)", "sub": "embeddings\nbge-m3 · 1024-d"},
        "CLAUDE": {"sub": "Anthropic API (direct)\nanswers · agents · judges"},
    },
    [("Docker Compose", "ivolve server\nivolve-network · volumes"),
     (".env file", "API keys · DB password\nAUTH_SECRET"),
     ("Port 8000 (HTTP)", "no TLS proxy yet\n(needed before go-live)"),
     ("reg.ivolve.cloud", "docker-publish.sh\ndocker compose logs")],
    COMMON_LEGEND + ["Everything runs in containers on one server; data leaves only for Anthropic, Langfuse and allow-listed web"],
)

btp = build(
    "Solvay Spark Spine AI — Target Architecture on SAP BTP",
    {
        "UI": {"sub": "React · HTML5 App Repo\nManaged Approuter"},
        "AUTH": {"title": "IAS + XSUAA", "sub": "SSO (corporate IdP)\nrole collections · JWT"},
        "API": {"sub": "FastAPI on Kyma\nREST + SSE"},
        "GUARD": {"sub": "scope check + Orchestration\nfiltering · data masking"},
        "INGEST": {"sub": "Docling on Kyma\nOCR · tables · diagrams"},
        "KG": {"sub": "build · traverse\nNL → openCypher"},
        "NEO": {"title": "HANA Graph Engine", "sub": "openCypher workspace\n(HANA Cloud)"},
        "FILES": {"title": "SAP Object Store", "sub": "corpus · graph JSON\n.workdir renders"},
        "MEM": {"sub": "on Kyma · memory in\nHANA · LLM via AI Core"},
        "PG": {"title": "HANA Cloud Vector", "sub": "vector + full-text index\nscores · run history"},
        "LF": {"title": "SAP Cloud Logging", "sub": "traces (OpenTelemetry)\n+ AI Launchpad evals"},
        "CLAUDE": {"title": "SAP Gen AI Hub", "sub": "Claude via AI Core\nOrchestration service"},
        "OLLAMA": {"title": "Gen AI Hub embeddings", "kind": "ext", "shape": "cloud",
                   "sub": "or HANA VECTOR_EMBEDDING\n(re-embed corpus)"},
    },
    [("SAP BTP, Kyma runtime", "Istio · service bindings\n3 worker nodes"),
     ("Credential Store", "secrets · Audit Log\nservice"),
     ("API Gateway", "TLS · Istio APIRule\n+ Approuter"),
     ("CI/CD + Transport Mgmt", "external registry\nAlert Notification · ALM")],
    COMMON_LEGEND + ["HANA Cloud replaces PostgreSQL + pgvector and Neo4j (one instance); Gen AI Hub replaces the Anthropic API and Ollama"],
    data_band="Data & Memory\n(HANA Cloud)",
)

azure = build(
    "Solvay Spark Spine AI — Target Architecture on Microsoft Azure",
    {
        "UI": {"sub": "React · served by API\nvia Front Door"},
        "AUTH": {"title": "Microsoft Entra ID", "sub": "SSO · app roles\nContainer Apps auth"},
        "API": {"sub": "FastAPI on Container Apps\nREST + SSE"},
        "GUARD": {"sub": "scope check +\nContent Safety · PII"},
        "INGEST": {"sub": "Docling on Container Apps\nOCR · tables · diagrams"},
        "NEO": {"title": "Apache AGE", "sub": "openCypher in PostgreSQL\n(read-only copy)"},
        "FILES": {"title": "Azure Files + Blob", "sub": "corpus · graph JSON\n.workdir renders"},
        "MEM": {"sub": "Container App\nmemory in PostgreSQL"},
        "PG": {"title": "Azure PostgreSQL", "sub": "Flexible Server · pgvector\nscores · run history"},
        "LF": {"title": "Application Insights", "sub": "traces · scores\n(or self-hosted Langfuse)"},
        "CLAUDE": {"title": "Claude in Foundry", "sub": "Opus 5 · Sonnet 5 · Haiku\nanswers · agents · judges"},
        "OLLAMA": {"title": "bge-m3 (container)", "sub": "embeddings kept as-is\nno re-embed"},
    },
    [("Container Apps env", "Dedicated D8 nodes\nVNet · private endpoints"),
     ("Key Vault", "secrets · managed\nidentities"),
     ("Front Door Premium", "TLS · WAF\nPrivate Link to app"),
     ("ACR + GitHub Actions", "Azure Monitor · alerts\nDefender for Cloud")],
    COMMON_LEGEND + ["Near lift-and-shift: PostgreSQL + pgvector stay; Apache AGE replaces Neo4j in the same server; Claude via Foundry (same Anthropic API)"],
    data_band="Data & Memory\n(one PostgreSQL)",
)

for l in local["links"]:
    if l.get("label") == "HTTPS": l["label"] = "HTTP :8000"
for name, spec in [("architecture-local", local), ("architecture-sap-btp", btp), ("architecture-azure", azure)]:
    spec = relax(spec, 1.4, 1.6)
    json.dump(spec, open(f"{docs}/{name}.spec.json", "w"), indent=1, ensure_ascii=False)
    print("wrote", name)
