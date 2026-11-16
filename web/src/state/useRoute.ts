import { useCallback, useEffect, useState } from "react";
import { formatRoute, parseRoute, type Route } from "./route";

/**
 * Keep the current route in step with the URL hash.
 *
 * Returns the route and a `navigate` function. `navigate` writes the hash; the browser's
 * `hashchange` event then updates the route, so links, the back button and code all take the
 * same path.
 */
export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    window.location.hash = formatRoute(next);
  }, []);

  return [route, navigate];
}
