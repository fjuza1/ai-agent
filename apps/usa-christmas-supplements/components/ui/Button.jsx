export default function Button({ variant = "solid", className = "", ...props }) {
  return <button type="button" className={`${variant === "outline" ? "button-outline " : ""}${className}`.trim()} {...props} />;
}
