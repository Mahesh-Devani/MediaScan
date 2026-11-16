declare const AMR: {
  Mode: {
    MR475: number;
    MR515: number;
    MR59: number;
    MR67: number;
    MR74: number;
    MR795: number;
    MR102: number;
    MR122: number;
    MRDTX: number;
  };
  SIZES: number[];
  PCM_BUFFER_COUNT: number;
  AMR_BUFFER_COUNT: number;
  AMR_HEADER: string;
  WAV_HEADER_SIZE: number;
  encode(pcm: Float32Array, pcmSampleRate: number, mode?: number): Uint8Array | null;
  encodeFrames?(pcm16: Int16Array, mode: number, dtx: boolean): Uint8Array[];
  Encoder_Interface_init(dtx: number): any;
  Encoder_Interface_exit(state: any): void;
  Encoder_Interface_Encode(state: any, mode: number, inPtr: number, outPtr: number, forceSpeech: number): number;
};

export default AMR;
export { AMR };
