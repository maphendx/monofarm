// Remounts on every route change, replaying the page-in animation (globals.css).
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-in">{children}</div>;
}
