import { Clock3, GitBranch, Globe, MousePointer2, Printer, Repeat2, Send, SlidersHorizontal, Timer, Webhook, Zap, type LucideProps } from "lucide-react";

const icons = {
  "trigger.event": Zap,
  "trigger.cron": Clock3,
  "trigger.webhook": Webhook,
  "trigger.manual": MousePointer2,
  "flow.condition": GitBranch,
  "flow.wait": Timer,
  "flow.set_var": SlidersHorizontal,
  "flow.loop": Repeat2,
  "action.notify_telegram": Send,
  "action.http_request": Globe,
  "action.send_print": Printer,
};

export function WorkflowIcon({ type, ...props }: LucideProps & { type: string }) {
  const Icon = icons[type as keyof typeof icons] ?? GitBranch;
  return <Icon size={15} strokeWidth={1.7} {...props} />;
}
