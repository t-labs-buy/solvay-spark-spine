import { useSyncExternalStore } from "react";

import { historyScope, onHistoryScope, type HistoryScope } from "./auth";

/** The current history scope, re-rendering when an Admin switches it, so a
 *  page can list it among the things its history is loaded from. */
export default function useHistoryScope(): HistoryScope {
  return useSyncExternalStore(onHistoryScope, historyScope, historyScope);
}
