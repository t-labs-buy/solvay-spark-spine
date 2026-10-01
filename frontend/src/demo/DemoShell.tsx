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
 *  The sidebar has three states, remembered per browser:
 *    rail       the default: icons only, a label on hover
 *    expanded   icons and names (the menu button, or the chevron at its foot)
 *    hidden     no sidebar at all (the close button when expanded)
 */
import {
  AppBar, Box, ButtonBase, Chip, Divider, IconButton, ListItemIcon, Menu, MenuItem, Tab, Tabs,
  Toolbar, Tooltip, Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronsLeft, ChevronsRight, CircleUserRound, FlaskConical, Globe2, LogOut, Menu as MenuIcon,
  MessageSquareText, Moon, Network, Sun, X,
} from "lucide-react";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import AskPage from "../pages/AskPage";
import EvidencePage from "../pages/EvidencePage";
import KnowledgeGraphPage from "../pages/KnowledgeGraphPage";
import DemoLanding from "./DemoLanding";
import RolloutPage from "../pages/RolloutPage";
import type { Mode } from "../theme";
import BrandLogo from "../components/BrandLogo";

const PRODUCT = "Spark AI Spine";

type Page = "landing" | "graph" | "rollout" | "ask" | "evidence";

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

const ALL: Entry[] = [LANDING, ...PRIMARY, ...SECONDARY.flatMap((g) => g.items)];
/** Where /demo opens, straight after signing in: the introduction, so a
 *  presentation starts from what the product is before showing what it does. */
const HOME: Page = "landing";

const pathOf = (p: Page) => `/demo/${ALL.find((e) => e.value === p)!.slug}`;

function pageFromPath(): Page {
  const slug = location.pathname.replace(/^\/demo\/?/, "").split("/")[0];
  return ALL.find((e) => e.slug === slug)?.value ?? HOME;
}

type SidebarState = "hidden" | "rail" | "expanded";
// Renamed when the default changed from hidden to rail, so a browser that
// saved the old default starts from the new one instead of keeping it.
const SIDEBAR_KEY = "demo-sidebar-v2";
const RAIL = 60;
const EXPANDED = 240;

function initialSidebar(): SidebarState {
  try {
    const saved = localStorage.getItem(SIDEBAR_KEY);
    if (saved === "rail" || saved === "expanded" || saved === "hidden") return saved;
  } catch {
    /* private mode */
  }
  return "rail";
}

export default function DemoShell({ mode, onToggleMode }: { mode: Mode; onToggleMode: () => void }) {
  const [page, setPage] = useState<Page>(pageFromPath);
  const [visited, setVisited] = useState<Set<Page>>(() => new Set([pageFromPath()]));
  const [sidebar, setSidebar] = useState<SidebarState>(initialSidebar);
  const [account, setAccount] = useState<HTMLElement | null>(null);
  const [user, setUser] = useState<string>("");

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
    fetch("/api/demo/session")
      .then(async (res) => {
        if (res.status === 401) location.replace(`/demo/login?next=${encodeURIComponent(location.pathname)}`);
        else if (res.ok) setUser((await res.json()).user ?? "");
      })
      .catch(() => { /* offline: the server will say so on the next request */ });
  }, []);

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

  const signOut = async () => {
    setAccount(null);
    await fetch("/api/demo/logout", { method: "POST" }).catch(() => undefined);
    location.replace("/demo/login");
  };

  const render = (p: Page): ReactNode => {
    switch (p) {
      case "landing": return <DemoLanding onNavigate={go} />;
      case "graph": return <KnowledgeGraphPage active={page === "graph"} onNavigate={fromApp} incomingQuery={null} />;
      case "rollout": return <RolloutPage active={page === "rollout"} showTechDetails={false} />;
      case "ask": return <AskPage active={page === "ask"} showTechDetails={false} />;
      case "evidence": return <EvidencePage active={page === "evidence"} showTechDetails={false} />;
    }
  };

  const sidebarWidth = sidebar === "hidden" ? 0 : sidebar === "rail" ? RAIL : EXPANDED;

  return (
    <Box sx={{ height: "100vh", display: "flex", flexDirection: "column", bgcolor: "background.default" }}>
      <AppBar position="static" color="default" elevation={0}
              sx={{ borderBottom: 1, borderColor: "divider", bgcolor: "background.paper" }}>
        <Toolbar variant="dense" disableGutters sx={{ minHeight: 52, px: 1.5, gap: 1.5 }}>
          <Tooltip title={sidebar === "expanded" ? "Minimize other modules" : "Show other modules"}>
            <IconButton
              onClick={() => setSidebar(sidebar === "expanded" ? "rail" : "expanded")}
              aria-label={sidebar === "expanded" ? "Minimize other modules" : "Show other modules"}
              aria-expanded={sidebar === "expanded"} aria-controls="demo-sidebar"
            >
              <MenuIcon size={19} />
            </IconButton>
          </Tooltip>

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
          {isModule && (
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
          <Tooltip title="Account">
            <IconButton onClick={(e) => setAccount(e.currentTarget)} aria-label="Account" aria-haspopup="menu">
              <CircleUserRound size={19} />
            </IconButton>
          </Tooltip>
          <Menu anchorEl={account} open={!!account} onClose={() => setAccount(null)}
                anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
                transformOrigin={{ vertical: "top", horizontal: "right" }}>
            <Box sx={{ px: 2, py: 1 }}>
              <Typography sx={{ fontSize: 12, color: "text.secondary" }}>Signed in as</Typography>
              <Typography sx={{ fontWeight: 600 }}>{user || "demo"}</Typography>
            </Box>
            <Divider />
            <MenuItem onClick={signOut}>
              <ListItemIcon><LogOut size={17} /></ListItemIcon>
              Sign out
            </MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>

      <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
        <Box
          id="demo-sidebar" component="nav" aria-label="Other modules"
          aria-hidden={sidebar === "hidden"} inert={sidebar === "hidden"}
          sx={{
            width: sidebarWidth, flexShrink: 0, overflow: "hidden",
            borderRight: sidebar === "hidden" ? 0 : 1, borderColor: "divider", bgcolor: "background.paper",
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
