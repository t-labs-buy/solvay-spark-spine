# Fit-Gap Copilot demo video: script

A short walkthrough for business users on how to run a Fit-Gap Copilot analysis.
Recorded as a regular (non-Admin) user. This script matches the finished video,
`docs/demo-video-quickstart/fitgap-quickstart.mp4` (2:28); the video is built from
`docs/demo-video-quickstart/scenes.json` and `scenes.py`.

## Script

| # | On screen | Narration |
|---|---|---|
| **1. Intro** (0:00–0:10) | Title card: *How to run a Fit-Gap analysis*, with a note that the India customer returns document is synthetic | "Hello, and welcome. In the next few minutes, I'll show you how to run an analysis with the Fit-Gap Copilot in Spark AI Spine." |
| **2. Sign in** (0:10–0:22) | Sign-in page; the caption shows `solvay-sparkai.ivolve.cloud/demo`. Type the username and password, click **Sign in** | "To get started, open your browser and go to solvay-sparkai.ivolve.cloud/demo. Enter the username and password you were given, then click **Sign in**." |
| **3. Home page** (0:22–0:31) | Home page, then point to the **Spine** and **Fit-Gap Copilot** tabs at the top | "After you sign in, you'll land on the home page. At the top, you'll see two tabs: **Spine** and **Fit-Gap Copilot**." |
| **4. Spine** (0:31–0:49) | The Spine graph: zoom in slightly, then point to **Business Streams**, **Core Systems** and **BPML Processes** in the filter list | "Before we run the analysis, let's take a quick look at Spine. This is a knowledge graph built from the documents that Solvay shared with us. It shows how the business streams, core systems and BPML processes connect to one another." |
| **5a. Sources** (0:49–1:05) | Click **Fit-Gap Copilot**. Point to **1. Sources**, *Attach the Country As-Is to start*, then the list of file types | "Now let's open the Fit-Gap Copilot. In the **Sources** section, attach your country document, the one that describes how the process runs in that country today. You can upload PDF, Word, Excel, PowerPoint or text files." |
| **5b. Upload** (1:05–1:21) | Point to **Attach as** (**Country As-Is**), click **Attach documents**, choose `India_Customer_Returns_As_Is.txt` from the Desktop. Stay on the progress bar: *chunking and embedding* → *extracting entities* (about 26 s; it keeps going into step 6) | "For this demo, I'll attach the India customer returns document from my desktop. As soon as the file is attached, the app reads it and prepares it for analysis. The document is compared against Solvay's Global Template and SAP Best Practices." |
| **6. Scope** (1:21–1:30) | Scroll to **2. Scope**, type `India` in **Country**, then point to **Additional Instructions (optional)** and leave it empty | "In the **Scope** section, you can add instructions to focus the analysis on a particular area, for example approval thresholds or e-invoicing." |
| *Pause* (1:30–1:32) | Two seconds with no narration; the cursor moves to **Run analysis** | — |
| **7a. Run** (1:32–1:44) | Click **Run analysis**. Point to **Progress**, then the **Investigation** section. When **Logs** is enabled, click it, scroll the **Investigation log**, then close it | "When you're ready, click **Run analysis**. The agent starts working right away. You can see what the agents are doing in the **Investigation** section; click **Logs** to see each step in detail." |
| **7b. Stop and open a past run** (1:44–1:54) | Click **Stop**. Scroll back to the top, rest on **History** for a second, click it. Under **Past runs**, choose **4.10.2 Process Returns** (*GT 58.8%*), then **Load into page** | "A full analysis takes around ten minutes, so let's stop this run and open one I completed earlier from **History**." |
| **8. Results** (1:54–2:18) | The loaded run: point to **Alignment to the Global Template** (58.8%), open the **Deviations** tab, then **Workshop agenda**, then point to *Proposed · awaiting workshop* | "When the analysis is complete, the results are organized into tabs. The **Summary** shows how closely the country's process aligns with the Global Template. **Deviations** lists each gap that was found, and the **Workshop agenda** shows the items that need a decision. Every finding stays *proposed* until someone on your team reviews and accepts it." |
| **9. Close** (2:18–2:28) | Closing card: *From one document to a workshop agenda*, three bullets and the app address | "And that's it: you've seen how to run a Fit-Gap Copilot analysis, from attaching your document to reviewing the results. Thank you for watching." |

Scenes change with straight cuts; there is no fade to black.

## Before recording

- **Attach type:** in **Sources**, keep the attach type on **Country As-Is**.
- **Additional Instructions:** leave the field empty; the narration explains it while the cursor points at it.
- **Country:** type `India` in the **Country** field in **Scope**.
- **Demo file:** have `India_Customer_Returns_As_Is.txt` on the Desktop. A `.txt` file skips the Docling conversion, so the screen shows only *chunking and embedding* → *extracting entities*.
- **Upload processing:** about 26 seconds. Start it at "For this demo" so the narration covers the wait; **Run analysis** is enabled once it finishes.
- **SAP Best Practices:** the comparison only runs when a Best Practice document is attached or already indexed; otherwise the results report it as "not assessable". The past run used in step 8 includes it (58.8%).
- **Past run for steps 7b and 8:** the finished **4.10.2 Process Returns** run (*GT 58.8%*) must be in the recording account's **History**. If it is deleted, run the India analysis to completion again first.
- **Logs button:** it stays greyed out until the first log line arrives, a few seconds after **Run analysis**.
- **Stop before loading:** **Load into page** is disabled while an analysis is running, so stop the live run first.
- **History button:** after **Stop** the page is scrolled down; scroll back to the top so the click on **History** is visible.
- **Each take leaves a run:** every recording of steps 5–7 leaves one interrupted India run in **History**; delete them afterwards.
- **Privacy:** the username is shown as dots, and the *Deciding as* field (which holds the user's e-mail address) is hidden.
- **Client visibility:** confirm the country document and its results are fine for the client to see.
