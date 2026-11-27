import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";

import {
  demoReducer,
  loadState,
  saveState,
  type DemoAction,
  type DemoState,
} from "@/lib/demo-store";

interface DemoStore {
  state: DemoState;
  dispatch: Dispatch<DemoAction>;
}

const DemoStoreContext = createContext<DemoStore | null>(null);

export function DemoStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(demoReducer, undefined, () => loadState(new Date()));

  useEffect(() => {
    saveState(state);
  }, [state]);

  return <DemoStoreContext value={{ state, dispatch }}>{children}</DemoStoreContext>;
}

export function useDemoStore(): DemoStore {
  const store = useContext(DemoStoreContext);
  if (!store) throw new Error("useDemoStore must be used inside DemoStoreProvider");
  return store;
}
