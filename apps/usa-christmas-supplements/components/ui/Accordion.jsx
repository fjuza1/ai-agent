export default function Accordion({ title, children, open = false }) {
  return <details className="accordion" open={open}><summary>{title}</summary><div className="mt-3">{children}</div></details>;
}
