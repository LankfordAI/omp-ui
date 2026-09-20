import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { displayMessage } from "../backend";

export type Load<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; value: T }
  | { status: "error"; message: string };

/** Runs one asynchronous read and ignores every result superseded or unmounted. */
export function useLoad<T>(read: (() => Promise<T>) | null): {
  load: Load<T>;
  setLoad: Dispatch<SetStateAction<Load<T>>>;
  retry: () => void;
} {
  const [load, setLoad] = useState<Load<T>>({ status: "idle" });
  const [retryGeneration, setRetryGeneration] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    if (read === null) {
      setLoad({ status: "idle" });
      return;
    }
    setLoad({ status: "loading" });
    void read().then(
      (value) => {
        if (generation.current === current) setLoad({ status: "loaded", value });
      },
      (error: unknown) => {
        if (generation.current === current) {
          setLoad({ status: "error", message: displayMessage(error) });
        }
      },
    );
    return () => {
      if (generation.current === current) generation.current += 1;
    };
  }, [read, retryGeneration]);

  const retry = useCallback(() => setRetryGeneration((value) => value + 1), []);
  return { load, setLoad, retry };
}
