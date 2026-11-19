export default function Badge({ children, className = "", ...props }) {
  return <span className={`trust-badge ${className}`.trim()} {...props}>{children}</span>;
}
