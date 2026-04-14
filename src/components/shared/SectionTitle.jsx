export default function SectionTitle({ children }) {
  return (
    <h3 className="font-display text-xs font-bold tracking-[3px] uppercase text-foreground/80">
      {children}
    </h3>
  );
}