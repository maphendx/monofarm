import type { LucideProps } from "lucide-react";
import type { ComponentType } from "react";

interface IconProps extends Omit<LucideProps, "ref"> {
  icon: ComponentType<LucideProps>;
}

export function Icon({ icon: Component, strokeWidth = 1.6, absoluteStrokeWidth = true, ...props }: IconProps) {
  return <Component strokeWidth={strokeWidth} absoluteStrokeWidth={absoluteStrokeWidth} {...props} />;
}
