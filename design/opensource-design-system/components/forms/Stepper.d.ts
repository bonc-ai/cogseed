/** 步进器。精确数值一律走此控件并显示单位。 */
export interface StepperProps {
  value?: number;
  step?: number;
  min?: number;
  max?: number;
  width?: number;
  onChange?: (value: number) => void;
  style?: React.CSSProperties;
}
export declare function Stepper(props: StepperProps): JSX.Element;
