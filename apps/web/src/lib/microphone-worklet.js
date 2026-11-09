/* global AudioWorkletProcessor, registerProcessor */
class InterviewMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new DataView(new ArrayBuffer(960));
    this.offset = 0;
  }
  process(inputs) {
    const mono = inputs[0]?.[0];
    if (mono) {
      for (const sample of mono) {
        const value = Math.max(-1, Math.min(1, sample));
        this.frame.setInt16(this.offset, Math.round(value * (value < 0 ? 32768 : 32767)), true);
        this.offset += 2;
        if (this.offset === this.frame.byteLength) {
          const bytes = this.frame.buffer;
          this.port.postMessage(bytes, [bytes]);
          this.frame = new DataView(new ArrayBuffer(960));
          this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('interview-microphone', InterviewMicrophone);
