"""Scenes for the Fit-Gap Copilot quick-start video (docs/fitgap-demo-video-script.md).

One function per "app" scene in scenes.json, same id. Each sets up, calls
mark() when its content is on screen, then at("<cue>") before each action.

Env: DEMO_URL (default https://solvay-sparkai.ivolve.cloud), DEMO_USERNAME and
DEMO_PASSWORD (required; never written to this file or scenes.json).
"""
import os
import re

from demo import *  # noqa: F401,F403

BASE_URL = os.environ.get("DEMO_URL", "https://solvay-sparkai.ivolve.cloud")


def login(pg):
    pg.goto(f"{BASE_URL}/demo")
    pg.fill("#demo-username", os.environ["DEMO_USERNAME"])
    pg.fill("#demo-password", os.environ["DEMO_PASSWORD"])
    pg.click('button:has-text("Sign in")')
    pg.wait_for_url(re.compile(r".*/demo/home"), timeout=20000)


RUN_CARD = "GT 58.8%"            # the finished India returns run's card in the History drawer
DEMO_FILE = os.path.expanduser("~/Desktop/India_Customer_Returns_As_Is.txt")


def to(pg, locator, dx=0, dy=0, steps=30):
    """Glide onto a locator's centre."""
    box = locator.bounding_box()
    if box:
        glide(pg, box["x"] + box["width"] / 2 + dx, box["y"] + box["height"] / 2 + dy, steps=steps)


def type_into(pg, locator, text, delay=35):
    click(pg, locator, 0.2)
    locator.press_sequentially(text, delay=delay)


def wait_enabled(pg, locator, timeout=40):
    for _ in range(int(timeout * 4)):
        if locator.is_enabled():
            return True
        pg.wait_for_timeout(250)
    print(f"  warning: still disabled after {timeout}s", flush=True)
    return False


def load_past_run(pg):
    history = pg.locator('button:has-text("History")').first
    to(pg, history, steps=40)
    hold(pg, 1.0)                     # let the viewer see the button before it opens
    click(pg, history, 1.0)
    click(pg, pg.locator(f"text={RUN_CARD}").first, 1.2)
    click(pg, pg.locator('button:has-text("Load into page")'), 0.5)
    hide_reviewer(pg)
    settle(pg, 1.5)


def hide_reviewer(pg):
    """'Deciding as' holds the signed-in user's e-mail address: keep it off screen."""
    pg.add_style_tag(content="#rollout-reviewer{color:transparent!important}")


def s02_signin(pg, mark, at):
    pg.context.clear_cookies()
    pg.goto(f"{BASE_URL}/demo")
    settle(pg, 1)
    # The username is a real address: draw it as dots, like the password.
    pg.add_style_tag(content="#demo-username{-webkit-text-security:disc}")
    glide(pg, W / 2, 470, steps=1)
    mark()
    at("Enter the username")
    type_into(pg, pg.locator("#demo-username"), os.environ["DEMO_USERNAME"], delay=30)
    type_into(pg, pg.locator("#demo-password"), os.environ["DEMO_PASSWORD"], delay=60)
    at("then click Sign in")
    click(pg, pg.locator('button:has-text("Sign in")'), 0.2)
    pg.wait_for_url(re.compile(r".*/demo/home"), timeout=20000)
    settle(pg, 0.5)
    at("After you sign in")
    glide(pg, W / 2, 300)
    still(pg, "s02_home")
    at("At the top")
    glide(pg, 400, 26)
    at("Spine and Fit-Gap Copilot")
    to(pg, pg.get_by_role("tab", name="Spine"))
    hold(pg, 1.2)
    to(pg, pg.get_by_role("tab", name="Fit-Gap Copilot"))


def s03_spine(pg, mark, at):
    pg.goto(f"{BASE_URL}/demo/graph")
    settle(pg, 3)
    glide(pg, 1300, 600, steps=1)
    mark()
    still(pg, "s03_graph")
    at("This is a knowledge graph")
    wheel(pg, 1350, 560, -240, 2)
    glide(pg, 1450, 450)
    at("It shows how the business streams")
    point(pg, "Business Streams", max_x=320)
    at("core systems")
    point(pg, "Core Systems", max_x=320)
    at("BPML processes connect")
    point(pg, "BPML Processes", max_x=320)
    hold(pg, 1.5)
    glide(pg, 1400, 750)


def s04_fitgap(pg, mark, at):
    pg.goto(f"{BASE_URL}/demo/graph")
    settle(pg, 2)
    glide(pg, 700, 300, steps=1)
    mark()
    hold(pg, 0.6)
    click(pg, pg.get_by_role("tab", name="Fit-Gap Copilot"), 0.5)
    settle(pg, 0.5)
    at("In the Sources section")
    point(pg, "1. Sources")
    hold(pg, 1.5)
    point(pg, "Attach the Country As-Is to start")
    at("You can upload PDF")
    point(pg, "Drag files here")
    at("For this demo")
    point(pg, "Attach as")
    hold(pg, 0.8)
    attach = pg.locator('button:has-text("Attach documents")')
    to(pg, attach)
    hold(pg, 0.3)
    with pg.expect_file_chooser() as fc:
        attach.click()
    fc.value.set_files(DEMO_FILE)
    hold(pg, 1)
    still(pg, "s04_uploading")
    at("As soon as the file is attached")
    point(pg, "India_Customer_Returns")
    at("The document is compared")
    point(pg, "India_Customer_Returns", dy=24)
    at("In the Scope section")
    reveal(pg, "2. Scope", offset=120)
    type_into(pg, pg.locator("#rollout-country"), "India", delay=60)
    at("for example approval thresholds")
    point(pg, "Additional Instructions")
    hold(pg, 1.2)
    to(pg, pg.locator("#rollout-question"), dx=-300)
    still(pg, "s04_scope")
    at("When you're ready")
    run = pg.locator('button:has-text("Run analysis")')
    to(pg, run)
    wait_enabled(pg, run)
    click(pg, run, 0.5)
    at("The agent starts working")
    point(pg, "Progress")
    at("You can see what the agents")
    reveal(pg, "Investigation", offset=140)
    point(pg, "Investigation")
    at("click Logs")
    logs = pg.locator('button:has-text("Logs")').first
    to(pg, logs)
    wait_enabled(pg, logs, timeout=30)
    click(pg, logs, 0.8)
    still(pg, "s04_logs")
    wheel(pg, W - 300, 600, 300, 1.5)
    at("A full analysis takes")
    pg.keyboard.press("Escape")
    hold(pg, 0.5)
    to(pg, pg.locator('button:has-text("Stop")').first)
    at("so let's stop this run")
    click(pg, pg.locator('button:has-text("Stop")').first, 0.6)
    # The History button sits in the page header, scrolled out of view by now.
    reveal(pg, "Compare a process with the Global Template", offset=200, settle_s=0.8)
    at("open one I completed earlier")
    load_past_run(pg)
    still(pg, "s04_past_run")


def s05_results(pg, mark, at):
    pg.goto(f"{BASE_URL}/demo/fit-gap-copilot")
    settle(pg, 1.5)
    load_past_run(pg)
    glide(pg, W / 2, 500, steps=1)
    mark()
    still(pg, "s05_summary")
    at("The Summary shows")
    point(pg, "Alignment to the Global Template")
    hold(pg, 1.5)
    point(pg, "58.8", max_x=400)
    at("Deviations lists")
    tab(pg, "Deviations")
    still(pg, "s05_deviations")
    at("the Workshop agenda shows")
    tab(pg, "Workshop agenda")
    still(pg, "s05_agenda")
    at("Every finding stays")
    point(pg, "Proposed · awaiting workshop")
