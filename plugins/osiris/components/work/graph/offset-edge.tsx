// Ported from BeadBoard (MIT, see third_party/beadboard-LICENSE.txt), src/components/graph/offset-edge.tsx @ 9e3059d. Logic verbatim; only the React import changed. See third_party/NOTICE-beadboard.md.
import type { CSSProperties } from "react";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from "@xyflow/react";

export function OffsetEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style = {}, markerEnd, data, label, labelStyle, labelBgStyle, labelBgPadding, labelBgBorderRadius, animated } = props;

  // We can pass `offset` via the edge data. Positive or negative pixels.
  const offset = (data?.offset as number | undefined) ?? 0;

  // Apply offset to the Y axis for Left/Right layouts (horizontal edges) or to the X axis for Top/Bottom layouts (vertical edges).
  let sx = sourceX, sy = sourceY, tx = targetX, ty = targetY;
  if (sourcePosition === "right" || sourcePosition === "left") { sy += offset; ty += offset; }
  else { sx += offset; tx += offset; }

  const [edgePath, labelX, labelY] = getSmoothStepPath({ sourceX: sx, sourceY: sy, sourcePosition, targetX: tx, targetY: ty, targetPosition, borderRadius: 8 });

  return <>
    <BaseEdge path={edgePath} markerEnd={markerEnd} className={animated ? "animated-edge" : ""} style={{ ...style, strokeDasharray: animated ? "5, 5" : "none" }} />
    {label && <EdgeLabelRenderer>
      <div
        style={{
          position: "absolute",
          transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          pointerEvents: "all",
          ...(labelBgStyle as CSSProperties),
          padding: Array.isArray(labelBgPadding) ? `${labelBgPadding[0]}px ${labelBgPadding[1]}px` : labelBgPadding,
          borderRadius: labelBgBorderRadius,
        }}
        className="nodrag nopan"
      >
        <div style={labelStyle as CSSProperties}>{label}</div>
      </div>
    </EdgeLabelRenderer>}
  </>;
}
