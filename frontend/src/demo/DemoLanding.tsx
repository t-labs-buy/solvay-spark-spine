/** The Demo Mode landing page: a project's documents as organizational
 *  memory, told in the order the client sees
 *  it -- the knowledge graph, the Fit-Gap Copilot, Ask RAG, the Evidence
 *  Agent -- over the application's own "How It Works" section, unchanged.
 *  Ask RAG and the Evidence Agent are an Admin's, so anyone else is shown
 *  only the first two steps. */
import { Box, Button, ButtonBase, Container, Stack, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { motion } from "framer-motion";
import { ArrowRight, FlaskConical, GitCompareArrows, MessageSquareText, Network } from "lucide-react";
import type { ReactNode } from "react";

import { ArchitectureSection, SERVICE_HUES, ServiceCard } from "../pages/LandingPage";
import { frappe } from "../theme";

export type DemoTarget = "graph" | "rollout" | "ask" | "evidence";

interface Step {
  target: DemoTarget;
  icon: ReactNode;
  title: string;
  question: string;
  subtitle: string;
  badge: string;
  description: string;
  features: string[];
  button: string;
}

const STEPS: Step[] = [
  {
    target: "graph", icon: <Network size={24} />, title: "Knowledge Graph",
    question: "What does the organizational memory hold?",
    subtitle: "See how the programme connects", badge: "Map the landscape",
    description: "Every indexed project document, read into one graph: the business streams, the core systems, the BPML processes and the SPARK specifications, and the documents that mention them. Start here to see what the organizational memory holds before asking it anything.",
    features: [
      "Streams, systems, BPML processes and SPARK specs in one view",
      "Filter by entity type and document category",
      "Ask the graph a question and see the path it followed",
      "Open any node for its documents and connections",
    ],
    button: "Open the Knowledge Graph",
  },
  {
    target: "rollout", icon: <GitCompareArrows size={24} />, title: "Fit-Gap Copilot",
    question: "Where does the country differ from the Global Template?",
    subtitle: "Country process against the Global Template", badge: "Fit-to-Standard",
    description: "Attach the country's As-Is — an SOP, a BPMN model, workshop notes. The agent reads it step by step, compares it with the Global Template and SAP Best Practice, and turns every difference into a decision for the workshop, with evidence from both sides.",
    features: [
      "Alignment score, with the arithmetic behind it",
      "Deviation register with quotes from both sides",
      "Timed workshop agenda and a facilitator mode",
      "Decisions recorded by name, exported as a PDF pack",
    ],
    button: "Open the Fit-Gap Copilot",
  },
  {
    target: "ask", icon: <MessageSquareText size={24} />, title: "Ask RAG",
    question: "What do the documents say about it?",
    subtitle: "Ask the documents directly", badge: "Grounded answers",
    description: "Ask a question in plain language. The answer is written only from excerpts found across the indexed documents, by meaning and by exact words and codes, and every statement carries a numbered citation you can open in its document.",
    features: [
      "Hybrid search: meaning and keywords, fused",
      "Numbered citations that open the source document",
      "Every answer scored by independent judges",
      "Says “I don't have the information” when it is out of scope",
    ],
    button: "Open Ask RAG",
  },
  {
    target: "evidence", icon: <FlaskConical size={24} />, title: "Evidence Agent",
    question: "Can we prove it?",
    subtitle: "An investigation you can audit", badge: "Verified claims",
    description: "For the questions that need proof. The agent chooses its engine — the graph for identity and counting, retrieval for substance — and reports separate claims, each with verified quotes and a score you can take apart. It says “not in the corpus” rather than guess.",
    features: [
      "Claims register with the score's arithmetic",
      "Every quote checked against the document it names",
      "Evidence map: which documents carry which claims",
      "Step-by-step investigation log",
    ],
    button: "Open the Evidence Agent",
  },
];

const ADMIN_ONLY = new Set<DemoTarget>(["ask", "evidence"]);
const COUNT = ["Zero", "One", "Two", "Three", "Four"];

export default function DemoLanding({ onNavigate, showEngines }: {
  onNavigate: (target: DemoTarget) => void; showEngines: boolean;
}) {
  const steps = showEngines ? STEPS : STEPS.filter((s) => !ADMIN_ONLY.has(s.target));
  const theme = useTheme();
  const hues = SERVICE_HUES[theme.palette.mode];
  const dark = theme.palette.mode === "dark";

  return (
    <Box sx={{ height: "100%", overflowY: "auto", overflowX: "hidden", bgcolor: "background.default" }}>
      <Container maxWidth="lg" sx={{ py: { xs: 5, md: 8 } }}>
        <Stack spacing={3} sx={{ textAlign: "center", alignItems: "center", mb: { xs: 6, md: 8 } }}>
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, delay: 0.1 }}>
            <Typography variant="h2" component="h1"
                        sx={{ fontWeight: 850, letterSpacing: "-0.03em", lineHeight: 1.15, maxWidth: 980,
                              fontSize: { xs: "2.2rem", sm: "2.9rem", md: "3.4rem" } }}>
              Turn project documents into{" "}
              <Box component="span"
                   sx={{ background: dark
                           ? `linear-gradient(135deg, ${frappe.blue} 0%, ${frappe.mauve} 50%, ${frappe.pink} 100%)`
                           : "linear-gradient(135deg, #2563eb 0%, #7c3aed 60%, #db2777 100%)",
                         WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                organizational memory
              </Box>
            </Typography>
          </motion.div>
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.2 }}>
            <Typography sx={{ color: "text.secondary", fontSize: { xs: 16, md: 19 }, lineHeight: 1.65, maxWidth: 800, mx: "auto" }}>
              Spark AI Spine gathers every document a project produces — workshop decks, minutes, specifications,
              BPML — into one organizational memory. It maps the landscape, compares a country with the Global
              Template and answers questions with evidence you can check, and it stays available to every
              project that follows.
            </Typography>
          </motion.div>
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.3 }}>
            <Button variant="contained" size="large" endIcon={<ArrowRight size={18} />} onClick={() => onNavigate("graph")}
                    sx={{ px: 3.5, py: 1.25, borderRadius: 2.5, fontWeight: 700, fontSize: 14.5 }}>
              Start the walkthrough
            </Button>
          </motion.div>
        </Stack>

        {/* the walkthrough, in order */}
        <Box component="nav" aria-label="The walkthrough"
             sx={{ display: "grid", gap: 1.5, mb: { xs: 7, md: 10 },
                   gridTemplateColumns: { xs: "1fr", sm: "repeat(2, 1fr)", md: `repeat(${steps.length}, 1fr)` } }}>
          {steps.map((s, i) => (
            <ButtonBase key={s.target} onClick={() => onNavigate(s.target)}
                        sx={{ display: "block", textAlign: "left", p: 2.25, borderRadius: 3, border: 1, borderColor: "divider",
                              bgcolor: "background.paper", position: "relative", transition: "border-color .2s, transform .2s",
                              "&:hover": { borderColor: hues[i], transform: "translateY(-2px)" },
                              "&:focus-visible": { outline: `2px solid ${hues[i]}`, outlineOffset: 2 } }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
                <Typography sx={{ fontFamily: "monospace", fontWeight: 800, fontSize: 13, color: hues[i] }}>
                  {String(i + 1).padStart(2, "0")}
                </Typography>
                <Box sx={{ flex: 1, height: 2, bgcolor: alpha(hues[i], 0.35) }} />
                {i < steps.length - 1 && <ArrowRight size={14} color={theme.palette.text.disabled} />}
              </Stack>
              <Typography sx={{ fontWeight: 750, fontSize: 16 }}>{s.title}</Typography>
              <Typography sx={{ fontSize: 13, color: "text.secondary", mt: 0.5, lineHeight: 1.5 }}>{s.question}</Typography>
            </ButtonBase>
          ))}
        </Box>

        <Box sx={{ mb: { xs: 8, md: 12 } }}>
          <Stack spacing={1.5} sx={{ textAlign: "center", mb: 5 }}>
            <Typography variant="overline" sx={{ color: "primary.main", fontWeight: 700, letterSpacing: "0.1em" }}>
              What you will see
            </Typography>
            <Typography variant="h4" sx={{ fontWeight: 800, letterSpacing: "-0.02em" }}>
              {COUNT[steps.length]} Steps, One Organizational Memory
            </Typography>
          </Stack>
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "repeat(2, 1fr)" }, gap: 3 }}>
            {steps.map((s, i) => (
              <ServiceCard key={s.target} icon={s.icon} color={hues[i]} title={`${i + 1}. ${s.title}`} subtitle={s.subtitle}
                           badge={s.badge} description={s.description} features={s.features} buttonText={s.button}
                           onClick={() => onNavigate(s.target)} />
            ))}
          </Box>
        </Box>

        <ArchitectureSection hideModels />
      </Container>
    </Box>
  );
}
