"""Scenes for the Fit-Gap Copilot demo video (India customer returns, run ro_879e0497a4).

One function per "app" scene in scenes.json. Each sets up, calls mark() when its
content is on screen, then at("<cue>") before each action so it lands as the
narration reaches those words. Read-only: nothing here clicks Accept, Defer,
Reject or Submit — facilitator mode is only opened and hovered.

Env: DEMO_URL (default http://localhost:8000), DEMO_USERNAME / DEMO_PASSWORD
(default solvay, the app's own Demo Mode defaults).
"""
import os
import re

from demo import *  # noqa: F401,F403

BASE_URL = os.environ.get("DEMO_URL", "http://localhost:8000")
USER = os.environ.get("DEMO_USERNAME", "solvay")
PASSWORD = os.environ.get("DEMO_PASSWORD", "solvay")
RUN_CARD = "GT 51.3% · harm 58.4%"      # the run's card in the History drawer


def login(pg):
    pg.goto(f"{BASE_URL}/demo")
    pg.fill("#demo-username", USER)
    pg.fill("#demo-password", PASSWORD)
    pg.click('button:has-text("Sign in")')
    pg.wait_for_url(re.compile(r".*/demo(?!/login).*"), timeout=20000)


def open_history(pg):
    pg.goto(f"{BASE_URL}/demo/fit-gap-copilot")
    settle(pg, 1)
    pg.click('button:has-text("History")')
    hold(pg, 1)
    pg.click(f"text={RUN_CARD}")
    hold(pg, 1.2)


def load_run(pg):
    open_history(pg)
    pg.click('button:has-text("Load into page")')
    settle(pg, 2)
    glide(pg, W / 2, 600, steps=1)


INSPECTOR = 1400   # the right-hand inspector column on the Deviations tab starts about here



def s01_hook(pg, mark, at):
    open_history(pg)
    mark()
    still(pg, "s01_history_preview")
    point(pg, "India's returns backbone", min_x=1360)
    at("It is synthetic")
    point(pg, "GT ALIGNMENT", min_x=1360)
    at("We attached that one document")
    wheel(pg, 1640, 700, 600, 5)
    at("This is what came back.")
    click(pg, pg.locator('button:has-text("Load into page")'), 1.5)
    still(pg, "s01_run_loaded")


CARD_Y = 330
CARD_X = {"gt": 265, "harm": 627, "loc": 990, "sap": 1352, "dev": 1715}


def s03_summary(pg, mark, at):
    load_run(pg)
    mark()
    still(pg, "s03_summary_scores")
    at("India's returns process is 51.3")
    glide(pg, CARD_X["gt"], CARD_Y)
    at("Against SAP Best Practice")
    glide(pg, CARD_X["sap"], CARD_Y)
    at("Harmonization potential is")
    glide(pg, CARD_X["harm"], CARD_Y)
    hold(pg, 3.5)
    glide(pg, CARD_X["harm"], 470, steps=15)          # 5 will standardise · 9 depend · 1 likely local
    at("There are fifteen deviations")
    glide(pg, CARD_X["dev"], CARD_Y)
    at("These are computed")
    glide(pg, CARD_X["gt"] - 60, CARD_Y + 60)
    at("Hover the score")
    pg.locator("text=51.3").first.hover()
    hold(pg, 1.2)
    still(pg, "s03_formula_tooltip")
    at("And it is not a keyword search.")
    glide(pg, 700, 760, steps=20)                     # tooltip closes
    reveal(pg, "Executive summary", offset=90, settle_s=1.5)
    point(pg, "India's returns backbone", max_x=1300)
    still(pg, "s03_exec_summary")
    at("Notice one more thing")
    reveal(pg, "Alignment to the Global Template", offset=120, settle_s=1.5)
    point(pg, "2.5 pts above", min_x=1150)
    hold(pg, 3)
    glide(pg, CARD_X["sap"], CARD_Y)


def s04_brief(pg, mark, at):
    load_run(pg)
    tab(pg, "Brief")
    mark()
    still(pg, "s04_brief_top")
    glide(pg, 250, 330)                               # 51.3 out of 100
    at("What we found")
    reveal(pg, "What we found", offset=110)
    point(pg, "India's returns backbone", dx=-60)
    at("The gaps sit in")
    point(pg, "India's returns backbone", dx=200, dy=40)
    at("Then the decisions")
    reveal(pg, "The decisions", offset=110)
    point(pg, "The decisions", dx=500, dy=20)
    at("Then where it diverges")
    reveal(pg, "Where it diverges", offset=110)
    point(pg, "Process flow", min_x=300, max_x=1300, dx=200)
    still(pg, "s04_brief_diverges")
    hold(pg, 3)
    point(pg, "Integration", min_x=300, max_x=1300, dx=200)
    at("And an India watchlist")
    point(pg, "India watchlist", dx=40)


def s05_gap01(pg, mark, at):
    load_run(pg)
    tab(pg, "Deviations")
    mark()
    still(pg, "s05_register")
    at("The Deviations register")
    glide(pg, 1100, 290, steps=20)                    # GT fit / SAP fit columns
    at("Take GAP-IN-RET-01")
    click(pg, pg.locator("#gap-GAP-IN-RET-01"), 0.8)
    still(pg, "s05_gap01_top")
    at("The comparison puts")
    reveal(pg, "Comparison", min_x=INSPECTOR, offset=110)
    still(pg, "s05_gap01_comparison")
    at("India: four approval tiers")
    point(pg, "Country As-Is", min_x=INSPECTOR, dx=40, dy=30)
    at("The Global Template: one automatic")
    point(pg, "Global Template", min_x=INSPECTOR, dx=40, dy=30)
    at("SAP Best Practice: no approval task")
    point(pg, "SAP Best Practice", min_x=INSPECTOR, dx=40, dy=30)
    at("The impact is scored too")
    reveal(pg, "Material impact", min_x=INSPECTOR, offset=110)
    point(pg, "Internal control", min_x=INSPECTOR, dx=120)
    still(pg, "s05_gap01_impact")
    at("The Copilot proposes")
    reveal(pg, "Decision · proposed", min_x=INSPECTOR, offset=110)
    point(pg, "Decision · proposed", min_x=INSPECTOR)
    still(pg, "s05_gap01_decision")
    at("It frames the question")
    point(pg, "Configure internal SAP approval workflow", min_x=INSPECTOR)
    hold(pg, 1.5)
    point(pg, "Owners:", min_x=INSPECTOR)
    at("Every claim is quoted")
    reveal(pg, "Evidence ·", min_x=INSPECTOR, offset=110)
    point(pg, "Evidence ·", min_x=INSPECTOR)
    still(pg, "s05_gap01_evidence")
    hold(pg, 3)
    wheel(pg, 1700, 700, 450, 4)
    at("In our dry run")
    reveal(pg, "Accepted by", min_x=INSPECTOR, offset=260)
    point(pg, "Accepted by", min_x=INSPECTOR)
    still(pg, "s05_gap01_outcome")


def s06_routes(pg, mark, at):
    load_run(pg)
    tab(pg, "Deviations")
    mark()
    at("The Risk view shows")
    click(pg, pg.locator("text=Risk view").first, 1.2)
    still(pg, "s06_risk_view")
    point(pg, "Where the deviations sit")
    hold(pg, 3)
    point(pg, "Proposed disposition", dy=60)
    at("Some routes surprise.")
    click(pg, pg.locator("text=Register").first, 0.8)
    at("On GAP-09")
    click(pg, pg.locator("#gap-GAP-IN-RET-09"), 0.8)
    point(pg, "GT fit", min_x=INSPECTOR, dy=20)
    still(pg, "s06_gap09")
    at("SAP has an Immediate Refund")
    reveal(pg, "SAP Best Practice", min_x=INSPECTOR, offset=200)
    point(pg, "SAP Best Practice", min_x=INSPECTOR, dx=40, dy=30)
    at("At the other end, GAP-11")
    reveal(pg, "GAP-IN-RET-11", max_x=300, offset=200, settle_s=0.8)
    click(pg, pg.locator("#gap-GAP-IN-RET-11"), 0.8)
    point(pg, "Critical", min_x=INSPECTOR)
    still(pg, "s06_gap11")
    at("The template is silent")
    reveal(pg, "Comparison", min_x=INSPECTOR, offset=110)
    point(pg, "Global Template", min_x=INSPECTOR, dx=40, dy=30)


def s07_alignment_loc(pg, mark, at):
    load_run(pg)
    tab(pg, "Process alignment")
    mark()
    still(pg, "s07_process_alignment")
    point(pg, "Receive Customer Return Request", dx=-100)
    hold(pg, 1.5)
    point(pg, "Close Return Case", dx=-100, steps=45)
    at("six fit with a deviation")
    point(pg, "Fits, with a deviation")
    at("Localization lists")
    tab(pg, "Localization", pause=1)
    still(pg, "s07_localization")
    point(pg, "IRN / e-invoicing")
    at("They stay candidates")
    point(pg, "Candidate")
    at("That is why")
    wheel(pg, 960, 700, 700, 4)


def s08_workshop(pg, mark, at):
    load_run(pg)
    tab(pg, "Workshop agenda")
    mark()
    still(pg, "s08_agenda")
    at("Eleven decisions")
    point(pg, "Workshop run-of-show", dy=90, dx=200)
    at("Each has its options")
    point(pg, "Options on the table", dy=40)
    at("The rail lists")
    point(pg, "Who needs to be in the room")
    at("four low-risk items")
    reveal(pg, "Batch-confirm", min_x=1400, offset=300)
    point(pg, "Batch-confirm", min_x=1400)
    at("In facilitator mode")
    reveal(pg, "Workshop run-of-show", offset=100, settle_s=0.6)
    click(pg, pg.locator('button:has-text("Start facilitating")'), 1.5)
    still(pg, "s08_facilitator")                      # decision 1 of 11; nothing is recorded
    at("the template's own words")
    point(pg, "Global template", min_x=1300)
    hold(pg, 1.8)
    point(pg, "Country As-Is", min_x=1300)
    hold(pg, 1.5)
    point(pg, "Impact if left as it is", min_x=1300)
    at("Accept, defer or reject")
    point(pg, "Rationale")
    hold(pg, 1)
    glide(pg, 1730, 1060)                             # hover the Accept button, never click it
    at("Every verdict goes")
    glide(pg, 960, 600)
    at("All fifteen items")
    exit_btn = pg.locator('button:has-text("Exit")')
    if exit_btn.count():
        click(pg, exit_btn.first, 1.0)
    point(pg, "15 of 15 decided")


def s09_trace(pg, mark, at):
    load_run(pg)
    tab(pg, "Sources")
    mark()
    still(pg, "s09_sources")
    at("Sources lists")
    point(pg, "10 documents")
    hold(pg, 1.5)
    point(pg, "93 read, not used")
    at("Traceability checks")
    tab(pg, "Traceability", pause=1)
    still(pg, "s09_traceability")
    at("forty-six of forty-six")
    point(pg, "46/46")
    hold(pg, 2)
    point(pg, "95/95")
