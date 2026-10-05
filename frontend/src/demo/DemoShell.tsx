/** The Demo Mode page: two primary tabs, everything else in a sidebar.
 *
 *  A client presentation is about two capabilities -- the Knowledge Graph and
 *  the Fit-Gap Copilot -- so those are the only tabs in the header. Every other
 *  module is still one click away in a sidebar that starts hidden, so a
 *  question from the room ("can it convert this deck?") can be answered
 *  without leaving the demo, but nothing competes for attention until then.
 *
 *  The pages are the application's own components, rendered unchanged. They
 *  mount on first visit rather than all at once -- a demo that opens on the
 *  graph should not also start the Ask and Quality pages' requests -- and stay
 *  mounted afterwards, so switching back keeps a query or a run on screen, as
 *  the application does.
 *
 *  The sidebar, and the menu button that opens it, are shown only to an
 *  Admin; anyone else sees the two header tabs alone, and a typed /demo/ask
 *  or /demo/agent lands on the introduction. For an Admin it has three
 *  states, remembered per browser:
 *    hidden     the default: no sidebar at all (the close button when expanded)
 *    rail       icons only, a label on hover
 *    expanded   icons and names (the menu button, or the chevron at its foot)
 */
import {
  AppBar, Box, Button, ButtonBase, Chip, Divider, IconButton, Tab, Tabs,
  Toolbar, Tooltip, Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronsLeft, ChevronsRight, FlaskConical, Globe2, Menu as MenuIcon,
  MessageSquareText, Moon, Network, ShieldCheck, Sun, X,
} from "lucide-react";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import AdminPage from "../pages/AdminPage";
import type { UsageTool } from "../api";
import type { RunRequest } from "../runRequest";
import AskPage from "../pages/AskPage";
import EvidencePage from "../pages/EvidencePage";
import KnowledgeGraphPage from "../pages/KnowledgeGraphPage";
import DemoLanding from "./DemoLanding";
import RolloutPage from "../pages/RolloutPage";
import type { Mode } from "../theme";
import BrandLogo from "../components/BrandLogo";
import type { Account } from "../auth";
import AccountMenu from "../components/AccountMenu";

const PRODUCT = "Spark AI Spine";

type Page = "landing" | "graph" | "rollout" | "ask" | "evidence" | "admin";

type Entry = { value: Page; label: string; icon: ReactElement; slug: string };

/** The header. Named as the application names them. */
const PRIMARY: Entry[] = [
  { value: "graph", label: "Spine", icon: <Network size={16} />, slug: "graph" },
  { value: "rollout", label: "Fit-Gap Copilot", icon: <Globe2 size={16} />, slug: "fit-gap-copilot" },
];

/** The sidebar, grouped the way the application's header groups them. */
/** The sidebar: the two other engines worth showing a client. The document
 *  tools (Convert, Batch Convert, Add to knowledge base), the inspection pages
 *  (Coverage, Doc vs MD, MD Viewer), InsightLens and RAG Metrics are left out
 *  of Demo Mode entirely -- not only unlisted but unroutable, so a typed
 *  /demo/convert lands on the introduction instead. They remain in the
 *  application at /. */
const SECONDARY: { title: string; items: Entry[] }[] = [
  {
    title: "Answer engines",
    items: [
      { value: "ask", label: "Ask RAG", icon: <MessageSquareText size={18} />, slug: "ask" },
      { value: "evidence", label: "Agent", icon: <FlaskConical size={18} />, slug: "agent" },
    ],
  },
];

/** The application's landing page, reached from the brand in the header as it
 *  is in the application. Neither a tab nor a sidebar entry: it is the
 *  introduction, not a module. */
const LANDING: Entry = { value: "landing", label: "Home", icon: <Network size={16} />, slug: "home" };

/** The Admin dashboard -- usage, accounts, activity -- the same page as the
 *  application's. Reached from a button beside the account menu, shown only
 *  to an Admin; anyone else who types /demo/admin is told it is for Admins
 *  and the server refuses its data. */
const ADMIN: Entry = { value: "admin", label: "Admin", icon: <ShieldCheck size={16} />, slug: "admin" };

const SIDEBAR_PAGES = new Set<Page>(SECONDARY.flatMap((g) => g.items.map((e) => e.value)));

const ALL: Entry[] = [LANDING, ...PRIMARY, ...SECONDARY.flatMap((g) => g.items), ADMIN];
/** Where /demo opens, straight after signing in: the introduction, so a
 *  presentation starts from what the product is before showing what it does. */
const HOME: Page = "landing";

const pathOf = (p: Page) => `/demo/${ALL.find((e) => e.value === p)!.slug}`;

function pageFromPath(): Page {
  const slug = location.pathname.replace(/^\/demo\/?/, "").split("/")[0];
  return ALL.find((e) => e.slug === slug)?.value ?? HOME;
}

type SidebarState = "hidden" | "rail" | "expanded";
// Renamed whenever the default changes, so a browser that saved the old
// default starts from the new one instead of keeping it.
const SIDEBAR_KEY = "demo-sidebar-v3";
const RAIL = 60;
const EXPANDED = 240;

function initialSidebar(): SidebarState {
  try {
    const saved = localStorage.getItem(SIDEBAR_KEY);
    if (saved === "rail" || saved === "expanded" || saved === "hidden") return saved;
  } catch {
    /* private mode */
  }
  return "hidden";
}

export default function DemoShell({ mode, onToggleMode }: { mode: Mode; onToggleMode: () => void }) {
  const [page, setPage] = useState<Page>(pageFromPath);
  const [visited, setVisited] = useState<Set<Page>>(() => new Set([pageFromPath()]));
  const [sidebar, setSidebar] = useState<SidebarState>(initialSidebar);
  const [account, setAccount] = useState<Account | null>(null);
  const isAdmin = account?.role === "admin";
  // Hidden until the session says Admin, so nobody sees it flash and vanish.
  const shownSidebar: SidebarState = isAdmin ? sidebar : "hidden";

  const isPrimary = PRIMARY.some((e) => e.value === page);
  const isModule = !isPrimary && page !== "landing";

  // The address bar is canonical: /demo alone becomes /demo/graph, so a
  // reload or a copied link lands on the same tab.
  useEffect(() => {
    if (location.pathname !== pathOf(page)) history.replaceState(null, "", pathOf(page));
    // Only on arrival; later changes go through go().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onPop = () => {
      const next = pageFromPath();
      setVisited((v) => (v.has(next) ? v : new Set(v).add(next)));
      setPage(next);
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const label = ALL.find((e) => e.value === page)?.label;
    document.title = `${PRODUCT} — ${label ?? "Demo"}`;
  }, [page]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebar);
    } catch {
      /* private mode */
    }
  }, [sidebar]);

  // The page is only served with a valid session, but a tab left open past
  // the session's end would otherwise go on looking signed in.
  useEffect(() => {
    fetch("/api/auth/session")
      .then(async (res) => {
        if (res.status === 401) location.replace(`/demo/login?next=${encodeURIComponent(location.pathname)}`);
        else if (res.ok) {
          const d = await res.json();
          setAccount({ id: d.id, username: d.username, role: d.role });
        }
      })
      .catch(() => { /* offline: the server will say so on the next request */ });
  }, []);

  // The sidebar's pages are an Admin's. Anyone else who reaches one -- a typed
  // address, a link from an Admin -- is taken to the introduction instead.
  useEffect(() => {
    if (account && !isAdmin && SIDEBAR_PAGES.has(page)) {
      history.replaceState(null, "", pathOf(HOME));
      setVisited((v) => (v.has(HOME) ? v : new Set(v).add(HOME)));
      setPage(HOME);
    }
  }, [account, isAdmin, page]);

  const go = (next: Page) => {
    if (next === page) return;
    history.pushState(null, "", pathOf(next));
    setVisited((v) => (v.has(next) ? v : new Set(v).add(next)));
    setPage(next);
  };

  /** The graph page links to other pages by the application's names. */
  const fromApp = (target: string) => {
    const known = ALL.find((e) => e.value === target);
    if (known) go(known.value);
  };


  // A run the Admin page asked a tool page to open. Demo Mode has no
  // InsightLens, so its runs are listed there but cannot be opened here.
  const [runRequests, setRunRequests] = useState<Partial<Record<Page, RunRequest>>>({});
  const DEMO_TOOL: Partial<Record<UsageTool, Page>> = { ask: "ask", evidence: "evidence", rollout: "rollout" };
  const openRunIn = (tool: UsageTool, id: string) => {
    const target = DEMO_TOOL[tool];
    if (!target) return;
    setRunRequests((r) => ({ ...r, [target]: { id, nonce: Date.now() } }));
    go(target);
  };

  const render = (p: Page): ReactNode => {
    switch (p) {
      case "landing": return <DemoLanding onNavigate={go} showEngines={isAdmin} />;
      case "graph": return <KnowledgeGraphPage active={page === "graph"} onNavigate={fromApp} incomingQuery={null} />;
      case "rollout": return <RolloutPage active={page === "rollout"} showTechDetails={false} openRun={runRequests.rollout} />;
      case "ask": return <AskPage active={page === "ask"} showTechDetails={false} openRun={runRequests.ask} />;
      case "evidence": return <EvidencePage active={page === "evidence"} showTechDetails={false} openRun={runRequests.evidence} />;
      case "admin": return <AdminPage active={page === "admin"} account={account} onOpenRun={openRunIn}
                                      canOpen={(t) => t in DEMO_TOOL} />;
    }
  };

  const sidebarWidth = shownSidebar === "hidden" ? 0 : shownSidebar === "rail" ? RAIL : EXPANDED;

  return (
    <Box sx={{ height: "100vh", display: "flex", flexDirection: "column", bgcolor: "background.default" }}>
      <AppBar position="static" color="default" elevation={0}
              sx={{ borderBottom: 1, borderColor: "divider", bgcolor: "background.paper" }}>
        <Toolbar variant="dense" disableGutters sx={{ minHeight: 52, px: 1.5, gap: 1.5 }}>
          {isAdmin && (
            <Tooltip title={sidebar === "expanded" ? "Minimize other modules" : "Show other modules"}>
              <IconButton
                onClick={() => setSidebar(sidebar === "expanded" ? "rail" : "expanded")}
                aria-label={sidebar === "expanded" ? "Minimize other modules" : "Show other modules"}
                aria-expanded={sidebar === "expanded"} aria-controls="demo-sidebar"
              >
                <MenuIcon size={19} />
              </IconButton>
            </Tooltip>
          )}

          <Box
            onClick={() => go("landing")} role="link" aria-label={`${PRODUCT} home`}
            sx={{ display: "flex", alignItems: "center", gap: 1.25, cursor: "pointer", userSelect: "none", "&:hover": { opacity: 0.8 } }}
          >
            <Box component={motion.div} whileHover={{ scale: 1.08 }} sx={{ display: "flex" }}>
              <BrandLogo size={30} />
            </Box>
            <Typography sx={{ fontWeight: 700, letterSpacing: "-.01em", whiteSpace: "nowrap", display: { xs: "none", sm: "block" } }}>
              Spark AI{" "}
              <Box component="span" sx={{ color: "text.secondary", fontWeight: 400 }}>Spine</Box>
            </Typography>
          </Box>

          <Tabs
            value={isPrimary ? page : false}
            onChange={(_, v) => go(v)}
            variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile
            sx={{
              minHeight: 52, flex: 1, minWidth: 0, ml: { sm: 1 },
              "& .MuiTab-root": { minHeight: 52, py: 0, px: 2, minWidth: 0, fontWeight: 600, textTransform: "none", fontSize: 14.5 },
            }}
          >
            {PRIMARY.map(({ value, label, icon }) => (
              <Tab key={value} value={value} label={label} icon={icon} iconPosition="start"
                   sx={(th) => ({
                     color: alpha(th.palette.primary.main, 0.8),
                     "&.Mui-selected": { color: th.palette.primary.main, bgcolor: alpha(th.palette.primary.main, 0.08) },
                     "&:hover": { bgcolor: alpha(th.palette.primary.main, 0.06) },
                   })} />
            ))}
          </Tabs>

          {/* When a sidebar module is open the header has no selected tab,
              so name the page here rather than leave the room guessing. */}
          {/* Not for Admin: its own button beside the account menu says so. */}
          {isModule && page !== "admin" && (
            <Chip size="small" variant="outlined"
                  icon={ALL.find((e) => e.value === page)?.icon}
                  label={ALL.find((e) => e.value === page)?.label}
                  sx={{ display: { xs: "none", md: "flex" }, "& .MuiChip-icon": { ml: 1 } }} />
          )}

          <Tooltip title={`Switch to ${mode === "dark" ? "light" : "dark"} theme`}>
            <IconButton onClick={onToggleMode} aria-label="Switch theme">
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={mode} initial={{ rotate: -90, opacity: 0, scale: 0.6 }}
                             animate={{ rotate: 0, opacity: 1, scale: 1 }}
                             exit={{ rotate: 90, opacity: 0, scale: 0.6 }} transition={{ duration: 0.2 }}
                             style={{ display: "flex" }}>
                  {mode === "dark" ? <Sun size={18} /> : <Moon size={18} />}
                </motion.span>
              </AnimatePresence>
            </IconButton>
          </Tooltip>
          {account?.role === "admin" && (
            <Tooltip title="Usage dashboard, accounts and the activity log">
              <Button size="small" onClick={() => go("admin")} startIcon={<ShieldCheck size={16} />}
                      variant={page === "admin" ? "contained" : "outlined"}
                      sx={{ flexShrink: 0, whiteSpace: "nowrap" }}>
                Admin
              </Button>
            </Tooltip>
          )}
          <AccountMenu account={account} loginPath="/demo/login"
                       onAdmin={account?.role === "admin" ? () => go("admin") : undefined} />
        </Toolbar>
      </AppBar>

      <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
        <Box
          id="demo-sidebar" component="nav" aria-label="Other modules"
          aria-hidden={shownSidebar === "hidden"} inert={shownSidebar === "hidden"}
          sx={{
            width: sidebarWidth, flexShrink: 0, overflow: "hidden",
            borderRight: shownSidebar === "hidden" ? 0 : 1, borderColor: "divider", bgcolor: "background.paper",
            transition: "width .2s ease", display: "flex", flexDirection: "column",
          }}
        >
          <Box sx={{ width: sidebar === "rail" ? RAIL : EXPANDED, flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", py: 1 }}>
            {SECONDARY.map((group, gi) => (
              <Box key={group.title} sx={{ mb: 0.5 }}>
                {sidebar === "expanded" ? (
                  <Typography variant="overline" sx={{ display: "block", px: 2.25, pt: gi ? 1.25 : 0.5, color: "text.secondary", lineHeight: 2 }}>
                    {group.title}
                  </Typography>
                ) : gi > 0 && <Divider sx={{ my: 1, mx: 1.5 }} />}
                {group.items.map((item) => (
                  <SideItem key={item.value} item={item} selected={page === item.value}
                            compact={sidebar === "rail"} onClick={() => go(item.value)} />
                ))}
              </Box>
            ))}
          </Box>
          <Divider />
          <Box sx={{ display: "flex", justifyContent: sidebar === "rail" ? "center" : "space-between", alignItems: "center", p: 0.75 }}>
            <Tooltip title={sidebar === "rail" ? "Expand" : "Collapse to icons"} placement="right">
              <IconButton size="small" onClick={() => setSidebar(sidebar === "rail" ? "expanded" : "rail")}
                          aria-label={sidebar === "rail" ? "Expand sidebar" : "Collapse sidebar"}>
                {sidebar === "rail" ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
              </IconButton>
            </Tooltip>
            {sidebar === "expanded" && (
              <Tooltip title="Hide sidebar">
                <IconButton size="small" onClick={() => setSidebar("hidden")} aria-label="Hide sidebar">
                  <X size={17} />
                </IconButton>
              </Tooltip>
            )}
          </Box>
        </Box>

        <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative" }}>
          {ALL.filter((e) => visited.has(e.value)).map(({ value }) => (
            <Box key={value} component={motion.div} initial={false}
                 animate={page === value ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
                 transition={{ duration: 0.2 }}
                 sx={{ position: "absolute", inset: 0, display: page === value ? "block" : "none" }}>
              {render(value)}
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

function SideItem({ item, selected, compact, onClick }: {
  item: Entry; selected: boolean; compact: boolean; onClick: () => void;
}) {
  const button = (
    <ButtonBase
      onClick={onClick} aria-current={selected ? "page" : undefined} aria-label={compact ? item.label : undefined}
      sx={(th) => ({
        width: compact ? 44 : "calc(100% - 16px)", mx: compact ? "auto" : 1, my: 0.25, px: compact ? 0 : 1.25,
        height: 40, borderRadius: 1.5, display: "flex", justifyContent: compact ? "center" : "flex-start", gap: 1.5,
        color: selected ? th.palette.primary.main : th.palette.text.primary,
        bgcolor: selected ? alpha(th.palette.primary.main, 0.1) : "transparent",
        fontWeight: selected ? 600 : 500, fontSize: 14,
        "&:hover": { bgcolor: selected ? alpha(th.palette.primary.main, 0.14) : th.palette.action.hover },
        "&:focus-visible": { outline: `2px solid ${th.palette.primary.main}`, outlineOffset: -2 },
      })}
    >
      <Box sx={{ display: "flex", flexShrink: 0, color: selected ? "primary.main" : "text.secondary" }}>{item.icon}</Box>
      {!compact && <Box component="span" sx={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.label}</Box>}
    </ButtonBase>
  );
  return compact ? <Tooltip title={item.label} placement="right">{button}</Tooltip> : button;
}
