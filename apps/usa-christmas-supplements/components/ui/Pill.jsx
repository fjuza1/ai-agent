export default function Pill({ children, className = "", ...props }) {
  return <span className={`fav-pill fav-pill-static ${className}`.trim()} {...props}>{children}</span>;
}
