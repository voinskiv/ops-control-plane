import * as React from "react"

import { cn } from "@core/lib/utils"

const variants = {
  default: "bg-primary text-primary-foreground",
  secondary: "bg-secondary text-secondary-foreground",
  destructive: "bg-destructive text-white",
  outline: "border-border text-foreground",
} as const

function Badge({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"span"> & { variant?: keyof typeof variants }) {
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      className={cn(
        "inline-flex min-h-7 w-fit shrink-0 items-center justify-center rounded-full border border-transparent px-3 py-1 text-sm font-semibold whitespace-nowrap",
        variants[variant],
        className,
      )}
      {...props}
    />
  )
}

export { Badge }
