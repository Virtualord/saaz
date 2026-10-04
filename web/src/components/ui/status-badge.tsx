import { cva, type VariantProps } from "class-variance-authority";
import { Badge } from "@/components/ui/badge";

/**
 * Semantic status badge for the cue pipeline.
 *
 * The five escalation outcomes map onto colours that mean something to a person
 * scanning a timeline: green is fine, amber means a machine adjusted something,
 * red means a human has to intervene. This exists separately from shadcn's
 * `Badge` because those variants are for categories, not for state.
 */
const statusBadgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-tight whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "border-border bg-muted text-muted-foreground",
        success: "border-success/30 bg-success/10 text-success",
        warning: "border-warning/30 bg-warning/10 text-warning",
        danger: "border-danger/30 bg-danger/10 text-danger",
        info: "border-primary/30 bg-primary/10 text-primary",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type StatusTone = NonNullable<VariantProps<typeof statusBadgeVariants>["tone"]>;

export function StatusBadge({
  tone = "neutral",
  className,
  ...props
}: React.ComponentProps<typeof Badge> & VariantProps<typeof statusBadgeVariants>) {
  return <Badge variant="outline" className={statusBadgeVariants({ tone, className })} {...props} />;
}