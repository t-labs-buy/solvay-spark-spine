# Solvay SPARK knowledge graph and query engine

The knowledge graph behind the **Knowledge Graph** page: what is in it, how its quality is checked, and how questions are answered over it.

Solvay Spark Spine AI includes an interactive enterprise Knowledge Graph (2,390 entities and 4,789 relationships, plus a passage layer of 8,867 chunks) constructed from Solvay SPARK project specifications, business streams, core systems, and BPML process taxonomies.

Users can explore the ontology visually via an interactive D3 force-directed canvas and ask natural language questions (e.g. *"What specs are linked to Salesforce?"*, *"How does eCommerce connect to S/4HANA?"*, *"What is BPML process O-020-090?"*).

**Cypher.** The graph is also loaded into a local Neo4j (`compose.neo4j.yml`, started by `./scripts/run.sh`) and can be queried with Cypher — in the **Cypher** view on the Knowledge Graph page, in Neo4j Browser at <http://localhost:7474>, or through `POST /api/graph/cypher` (read-only, enforced by Neo4j). `knowledge_graph.json` stays the source of truth; the Neo4j copy is replaced whenever the graph is rebuilt. See [docs/neo4j.md](neo4j.md).

## Graph quality

The **Quality** view on the Knowledge Graph page shows two checks
(`backend/graph/graph_eval.py`), with the same Pass / Watch / Below scores as the
agents' Evaluation tabs.

- **The graph itself.** This check calls no model and takes seconds. It runs when the view first opens, and again when you press **Check now**:
  - **Accuracy:** every passage an edge cites really names the edge's target.
  - **Completeness:** indexed documents in the graph; process codes found in BPML; hierarchy links present.
  - **Consistency:** relations between the right node types; no dangling or duplicate edges, hierarchy loops, two-parent processes or contradicting properties.
  - **Structure:** isolated nodes, the largest connected part, hubs.
  - **Freshness:** the graph and its Neo4j copy are built from the current corpus.
- **Plain-English questions.** Claude writes a Cypher query for each question in
  `data/graph_eval_questions.json`, and its rows are compared with a reference
  query's (execution accuracy). It makes one model call per question, so it runs
  only on request. The reference queries are marked `"reviewed": false` until
  someone who knows the programme has checked them.

Each run is kept in Postgres and scored on its trace, like the agents.

```bash
.venv/bin/python -m backend.graph.graph_eval structure   # check the graph now
.venv/bin/python -m backend.graph.graph_eval questions   # run the question check (calls Claude)
.venv/bin/python -m backend.graph.graph_eval rescore     # re-compare the last run, no model calls
.venv/bin/python -m backend.graph.graph_eval configs     # declare the score names, once
.venv/bin/python backend/tests/test_graph_eval.py
```

## How Our Graph Algorithm Works Compared to Neo4j

When you ask a natural-language question in the Knowledge Graph tab, **no SQL or Cypher query is written or executed** (Cypher is available separately, in the Cypher view). 

Instead, the system relies on deterministic in-memory graph traversal algorithms. Here is how our architecture compares to **Neo4j** and traditional **Relational SQL**:

| Dimension | Our In-Memory Engine (`knowledge_graph.py`) | Neo4j Graph Database | Traditional Relational SQL (PostgreSQL) |
|---|---|---|---|
| **Query Engine** | BFS Pathfinding & 2-Hop Bridge Traversal in Python | Cypher Engine (`MATCH (a)-[:REL]->(b) RETURN b`) | Relational Planner (`JOIN`, `GROUP BY`, `INDEX SCAN`) |
| **Data Structure** | In-Memory Adjacency List (`dict[str, list[tuple]]`) | Native Graph Storage (Disk + PageCache) | 2D Relational Tables with B-Tree Indexes |
| **Memory Pointers** | Direct in-memory Python references | Native Index-Free Adjacency (disk/RAM pointers) | Foreign Key lookup via Index Trees ($O(\log N)$) |
| **Pathfinding Cost** | $O(V + E)$ queue-based Breadth-First Search | $O(V + E)$ bidirectional BFS / Dijkstra | Exponential cost via recursive joins (`WITH RECURSIVE`) |
| **Multi-Hop Traversal** | **< 2 ms** for arbitrary hops | **< 2 ms** for arbitrary hops | High latency as join depth increases |
| **Setup & Footprint** | **Zero external dependencies** (built into Python) | Requires JVM daemon, Bolt protocol, network port | Requires running SQL server & table migrations |
| **Primary Use Case** | Local interactive workbench, deterministic ontology exploration, GraphQA | Enterprise-scale graphs (billions of nodes/edges), transactional ACID writes | Tabular, accounting, transactional records |

## The Algorithm Under the Hood

When a user submits a query via the Knowledge Graph query bar or clicks an entity in the UI:

1. **Natural Language Question & Intent Parsing**:
   - The engine analyzes the question structure to determine intent:
     - **Path Queries**: Patterns like `"How does X connect to Y"`, `"path from X to Y"`, or `"difference between X and Y"` trigger targeted pathfinding.
     - **Neighborhood Queries**: Patterns like `"What specs are linked to X"` or `"processes in L2C"` trigger typed neighborhood exploration.
   - User-supplied terms are resolved to canonical entity node IDs using exact and fuzzy substring matching across labels, codes, and tickets.

2. **Breadth-First Search (BFS) Shortest Path**:
   - When searching for connections between two systems (e.g. `Solvay@eCommerce` and `SAP S/4HANA`), the engine executes a queue-based BFS traversal over the adjacency list:
     ```
     [System: eCommerce] ⬅ (mentions_system) ⬅ [Doc: Interface Spec] ➔ (mentions_system) ➔ [System: SAP S/4HANA]
     ```
   - Returns the exact hop count, ordered sequence of nodes, and edge relationship labels.

3. **2-Hop Bridge Expansion**:
   - In enterprise ontologies, high-level platforms (like `Salesforce`) are often separated from specific technical tickets (`SPARK-22877`) by intermediate document or interface nodes.
   - A naive 1-hop search would only find the document; our engine automatically expands **2 hops through intermediate bridges** to retrieve all concrete SPARK tickets, while pruning unrelated nodes to keep the result focused and readable.

4. **GraphQA Answer Synthesis**:
   - Instead of generic vector chunk retrieval (which lacks relational awareness), the engine synthesizes a structured, factual answer grounded in the graph:
     - **Direct Answer**: Plain-language executive summary answering the question directly.
     - **Core Systems & Streams**: Roles and technical descriptions of every platform involved.
     - **SPARK Specifications & JIRA Tickets**: Exact ticket codes resolved to their human-readable functional titles.
     - **Step-by-Step Integration Flow**: Visual pipeline mapping how data and processes flow across boundaries.
     - **Source Document Citations**: Cites the exact Markdown files with character lengths.

5. **D3 Canvas Subgraph Isolation**:
   - The matched nodes and edges are highlighted with glowing auras and visible relation labels on the D3 canvas.
   - All unrelated nodes and edges are dimmed (`opacity: 0.12`).
   - The camera automatically calculates the bounding box of the matched subgraph and executes a smooth pan/zoom transition to frame the answer.
