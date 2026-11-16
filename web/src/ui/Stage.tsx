import type { Route } from "../state/route";

/** What each scene will show, and the part of docs/UI_PLAN.md that builds it. */
const PENDING: Record<Route["view"], { title: string; text: string }> = {
  globe: { title: "Globe", text: "The 3D Moon, centred on the south pole, is built in part 3 of the plan." },
  map: { title: "Polar map", text: "The flat south polar map is built in part 4 of the plan." },
  site: { title: "Site view", text: "The 3D terrain and the sky view are built in parts 5 and 6 of the plan." },
  point: { title: "Sky view", text: "The sky view for a custom point is built in part 6 of the plan." },
};

/**
 * The stage: the large area that holds the current scene.
 *
 * In this part of the rebuild no scene exists yet, so the stage says which scene belongs here
 * and when it arrives. It shows no picture and no number, because none is available from real
 * data yet.
 */
export function Stage({ route }: { route: Route }) {
  const pending = PENDING[route.view];
  return (
    <main className="stage" data-scene={route.view}>
      <div className="stage-pending">
        <h2>{pending.title}</h2>
        <p>{pending.text}</p>
      </div>
    </main>
  );
}
