import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";
import type { Health } from "../lib/api";

/**
 * The provenance panel.
 *
 * The product's central claim is "nothing leaves this machine". A claim like
 * that should be checkable, so every part of it is shown rather than asserted:
 * which weights are loaded, under which licence, and whether they are on disk
 * right now.
 */
export function ProvenancePanel({ health, error }: { health: Health | null; error: string | null }) {
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>Cannot reach the local service</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (!health) {
    return (
      <Card className="shadow-none">
        <CardContent className="py-6 text-sm text-muted-foreground">
          Checking what is running…
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="shadow-none">
        <CardContent className="grid gap-4 py-5 sm:grid-cols-4">
          {[
            { k: "runtime", v: health.inference.runtime },
            { k: "device", v: health.inference.device },
            {
              k: "third-party AI APIs",
              v: health.inference.remoteApisUsed.length === 0 ? "none" : health.inference.remoteApisUsed.join(", "),
              good: health.inference.remoteApisUsed.length === 0,
            },
            {
              k: "weights on disk",
              v: health.inference.defaultsCachedLocally ? "ready, runs offline" : "not yet fetched",
              good: health.inference.defaultsCachedLocally,
              warn: !health.inference.defaultsCachedLocally,
            },
          ].map((item) => (
            <div key={item.k} className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {item.k}
              </span>
              <span
                className={`font-mono text-[13px] ${
                  item.good ? "text-success" : item.warn ? "text-warning" : ""
                }`}
              >
                {item.v}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      {health.slots.map((slot) => (
        <Card key={slot.slot} className="shadow-none">
          <CardContent className="py-5">
            <div className="mb-3 flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-[13px] font-medium">{slot.slot}</span>
              <span className="text-[13px] text-muted-foreground">{slot.purpose}</span>
            </div>
            <ul className="grid gap-2">
              {slot.models.map((m) => (
                <li
                  key={m.id}
                  className={`rounded-lg border p-3 ${
                    m.id === slot.defaultModelId ? "border-primary/40 bg-primary/[0.03]" : "border-border"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13.5px] font-medium">{m.label}</span>
                    {m.id === slot.defaultModelId && <StatusBadge tone="info">default</StatusBadge>}
                    <a
                      href={m.licenseUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded border border-border px-1.5 py-px font-mono text-[10px] text-primary hover:bg-primary/5"
                    >
                      {m.license}
                    </a>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {m.dtype} · ~{m.approxMb}MB
                    </span>
                    <span
                      className={`ml-auto font-mono text-[10px] ${
                        m.cachedLocally ? "text-success" : "text-warning"
                      }`}
                    >
                      {m.cachedLocally ? (m.loaded ? `loaded ${m.loadMs}ms` : "cached") : "not fetched"}
                    </span>
                  </div>
                  {m.licenseNote && (
                    <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
                      {m.licenseNote}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}