import { useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { useGpuVisibility } from "@/hooks/use-gpu-visibility";
import { cn } from "@/lib/utils";

interface GpuSelectorProps {
  gpuAuto: boolean;
  selectedGpuIds: number[];
  onAutoChange: (auto: boolean) => void;
  onGpuToggle: (gpuIndex: number) => void;
}

export function GpuSelector({
  gpuAuto,
  selectedGpuIds,
  onAutoChange,
  onGpuToggle,
}: GpuSelectorProps) {
  const { devices, parentVisibleGpuIds, isMultiGpu } = useGpuVisibility();

  // Reconcile stale selections when GPU visibility changes
  useEffect(() => {
    if (gpuAuto || !isMultiGpu) return;
    const valid = selectedGpuIds.filter((id) =>
      parentVisibleGpuIds.includes(id),
    );
    if (valid.length === 0) {
      onAutoChange(true);
      return;
    }
    if (valid.length !== selectedGpuIds.length) {
      for (const id of selectedGpuIds) {
        if (!parentVisibleGpuIds.includes(id)) {
          onGpuToggle(id);
        }
      }
    }
  }, [gpuAuto, isMultiGpu, selectedGpuIds, parentVisibleGpuIds, onAutoChange, onGpuToggle]);

  if (!isMultiGpu) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <label className="flex items-center gap-1.5">
        <Switch
          checked={gpuAuto}
          onCheckedChange={onAutoChange}
          className="scale-75 origin-left"
        />
        <span className="text-[11px] text-muted-foreground">Auto</span>
      </label>

      <div className="flex items-center gap-1.5 flex-wrap">
        {devices.map((device) => {
          const selected = gpuAuto || selectedGpuIds.includes(device.index);
          return (
            <button
              key={device.index}
              type="button"
              onClick={() => !gpuAuto && onGpuToggle(device.index)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] ring-1 transition-colors",
                gpuAuto
                  ? "opacity-40 pointer-events-none ring-foreground/10 text-muted-foreground"
                  : selected
                    ? "bg-foreground/10 text-foreground ring-foreground/15"
                    : "bg-transparent text-muted-foreground ring-foreground/10 hover:bg-foreground/5",
              )}
            >
              GPU {device.index} · {Math.round(device.memoryTotalGb)}GB
            </button>
          );
        })}
      </div>
    </div>
  );
}
