import { useEffect, useState } from "react";
import { Route, Routes } from "react-router";
import { fetchHealth, type HealthState } from "./api.ts";

// The walking skeleton's only page: the app's name and whether the API reaches its database.

function Health() {
  const [state, setState] = useState<HealthState>("checking");
  useEffect(() => {
    const controller = new AbortController();
    void fetchHealth(controller.signal).then((database) => {
      if (!controller.signal.aborted) setState(database);
    });
    return () => {
      controller.abort();
    };
  }, []);
  return (
    <main>
      <h1>Kindle Vocab</h1>
      <p>
        API: <span role="status">{state}</span>
      </p>
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Health />} />
    </Routes>
  );
}
