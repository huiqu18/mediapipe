/**
 * Copyright 2022 The MediaPipe Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {CalculatorGraphConfig} from '../../../../framework/calculator_pb';
import {CalculatorOptions} from '../../../../framework/calculator_options_pb';
import {AudioEmbedderGraphOptions as AudioEmbedderGraphOptionsProto} from '../../../../tasks/cc/audio/audio_embedder/proto/audio_embedder_graph_options_pb';
import {EmbeddingResult} from '../../../../tasks/cc/components/containers/proto/embeddings_pb';
import {BaseOptions as BaseOptionsProto} from '../../../../tasks/cc/core/proto/base_options_pb';
import {AudioTaskRunner} from '../../../../tasks/web/audio/core/audio_task_runner';
import {Embedding} from '../../../../tasks/web/components/containers/embedding_result';
import {convertEmbedderOptionsToProto} from '../../../../tasks/web/components/processors/embedder_options';
import {convertFromEmbeddingResultProto} from '../../../../tasks/web/components/processors/embedder_result';
import {computeCosineSimilarity} from '../../../../tasks/web/components/utils/cosine_similarity';
import {WasmFileset} from '../../../../tasks/web/core/wasm_fileset';
import {WasmModule} from '../../../../web/graph_runner/graph_runner';
// Placeholder for internal dependency on trusted resource url

import {AudioEmbedderOptions} from './audio_embedder_options';
import {AudioEmbedderResult} from './audio_embedder_result';

export * from './audio_embedder_options';
export * from './audio_embedder_result';

// The OSS JS API does not support the builder pattern.
// tslint:disable:jspb-use-builder-pattern

const AUDIO_STREAM = 'audio_in';
const SAMPLE_RATE_STREAM = 'sample_rate';
const EMBEDDINGS_STREAM = 'embeddings_out';
const TIMESTAMPED_EMBEDDINGS_STREAM = 'timestamped_embeddings_out';
const AUDIO_EMBEDDER_CALCULATOR =
    'mediapipe.tasks.audio.audio_embedder.AudioEmbedderGraph';

/** Performs embedding extraction on audio. */
export class AudioEmbedder extends AudioTaskRunner<AudioEmbedderResult[]> {
  private embeddingResults: AudioEmbedderResult[] = [];
  private readonly options = new AudioEmbedderGraphOptionsProto();

  /**
   * Initializes the Wasm runtime and creates a new audio embedder from the
   * provided options.
   * @param wasmFileset A configuration object that provides the location of the
   *     Wasm binary and its loader.
   * @param audioEmbedderOptions The options for the audio embedder. Note that
   *     either a path to the TFLite model or the model itself needs to be
   *     provided (via `baseOptions`).
   */
  static createFromOptions(
      wasmFileset: WasmFileset,
      audioEmbedderOptions: AudioEmbedderOptions): Promise<AudioEmbedder> {
    return AudioTaskRunner.createInstance(
        AudioEmbedder, /* initializeCanvas= */ false, wasmFileset,
        audioEmbedderOptions);
  }

  /**
   * Initializes the Wasm runtime and creates a new audio embedder based on the
   * provided model asset buffer.
   * @param wasmFileset A configuration object that provides the location of the
   *     Wasm binary and its loader.
   * @param modelAssetBuffer A binary representation of the TFLite model.
   */
  static createFromModelBuffer(
      wasmFileset: WasmFileset,
      modelAssetBuffer: Uint8Array): Promise<AudioEmbedder> {
    return AudioTaskRunner.createInstance(
        AudioEmbedder, /* initializeCanvas= */ false, wasmFileset,
        {baseOptions: {modelAssetBuffer}});
  }

  /**
   * Initializes the Wasm runtime and creates a new audio embedder based on the
   * path to the model asset.
   * @param wasmFileset A configuration object that provides the location of the
   *     Wasm binary and its loader.
   * @param modelAssetPath The path to the TFLite model.
   */
  static createFromModelPath(
      wasmFileset: WasmFileset,
      modelAssetPath: string): Promise<AudioEmbedder> {
    return AudioTaskRunner.createInstance(
        AudioEmbedder, /* initializeCanvas= */ false, wasmFileset,
        {baseOptions: {modelAssetPath}});
  }

  constructor(
      wasmModule: WasmModule,
      glCanvas?: HTMLCanvasElement|OffscreenCanvas|null) {
    super(wasmModule, glCanvas);
    this.options.setBaseOptions(new BaseOptionsProto());
  }

  protected override get baseOptions(): BaseOptionsProto {
    return this.options.getBaseOptions()!;
  }

  protected override set baseOptions(proto: BaseOptionsProto) {
    this.options.setBaseOptions(proto);
  }

  /**
   * Sets new options for the audio embedder.
   *
   * Calling `setOptions()` with a subset of options only affects those options.
   * You can reset an option back to its default value by explicitly setting it
   * to `undefined`.
   *
   * @param options The options for the audio embedder.
   */
  override async setOptions(options: AudioEmbedderOptions): Promise<void> {
    await super.setOptions(options);
    this.options.setEmbedderOptions(convertEmbedderOptionsToProto(
        options, this.options.getEmbedderOptions()));
    this.refreshGraph();
  }

  /**
   * Performs embeding extraction on the provided audio clip and waits
   * synchronously for the response.
   *
   * @param audioData An array of raw audio capture data, like from a call to
   *     `getChannelData()` on an AudioBuffer.
   * @param sampleRate The sample rate in Hz of the provided audio data. If not
   *     set, defaults to the sample rate set via `setDefaultSampleRate()` or
   *     `48000` if no custom default was set.
   * @return The embedding resuls of the audio
   */
  embed(audioData: Float32Array, sampleRate?: number): AudioEmbedderResult[] {
    return this.processAudioClip(audioData, sampleRate);
  }

  /**
   * Utility function to compute cosine similarity[1] between two `Embedding`
   * objects.
   *
   * [1]: https://en.wikipedia.org/wiki/Cosine_similarity
   *
   * @throws if the embeddings are of different types(float vs. quantized), have
   *     different sizes, or have an L2-norm of 0.
   */
  static cosineSimilarity(u: Embedding, v: Embedding): number {
    return computeCosineSimilarity(u, v);
  }

  protected override process(
      audioData: Float32Array, sampleRate: number,
      timestampMs: number): AudioEmbedderResult[] {
    this.graphRunner.addDoubleToStream(
        sampleRate, SAMPLE_RATE_STREAM, timestampMs);
    this.graphRunner.addAudioToStreamWithShape(
        audioData, /* numChannels= */ 1, /* numSamples= */ audioData.length,
        AUDIO_STREAM, timestampMs);

    this.embeddingResults = [];
    this.finishProcessing();
    return this.embeddingResults;
  }

  /** Updates the MediaPipe graph configuration. */
  private refreshGraph(): void {
    const graphConfig = new CalculatorGraphConfig();
    graphConfig.addInputStream(AUDIO_STREAM);
    graphConfig.addInputStream(SAMPLE_RATE_STREAM);
    graphConfig.addOutputStream(EMBEDDINGS_STREAM);
    graphConfig.addOutputStream(TIMESTAMPED_EMBEDDINGS_STREAM);

    const calculatorOptions = new CalculatorOptions();
    calculatorOptions.setExtension(
        AudioEmbedderGraphOptionsProto.ext, this.options);

    const embedderNode = new CalculatorGraphConfig.Node();
    embedderNode.setCalculator(AUDIO_EMBEDDER_CALCULATOR);
    embedderNode.addInputStream('AUDIO:' + AUDIO_STREAM);
    embedderNode.addInputStream('SAMPLE_RATE:' + SAMPLE_RATE_STREAM);
    embedderNode.addOutputStream('EMBEDDINGS:' + EMBEDDINGS_STREAM);
    embedderNode.addOutputStream(
        'TIMESTAMPED_EMBEDDINGS:' + TIMESTAMPED_EMBEDDINGS_STREAM);
    embedderNode.setOptions(calculatorOptions);

    graphConfig.addNode(embedderNode);

    this.graphRunner.attachProtoListener(EMBEDDINGS_STREAM, binaryProto => {
      const embeddingResult = EmbeddingResult.deserializeBinary(binaryProto);
      this.embeddingResults.push(
          convertFromEmbeddingResultProto(embeddingResult));
    });

    this.graphRunner.attachProtoVectorListener(
        TIMESTAMPED_EMBEDDINGS_STREAM, data => {
          for (const binaryProto of data) {
            const embeddingResult =
                EmbeddingResult.deserializeBinary(binaryProto);
            this.embeddingResults.push(
                convertFromEmbeddingResultProto(embeddingResult));
          }
        });

    const binaryGraph = graphConfig.serializeBinary();
    this.setGraph(new Uint8Array(binaryGraph), /* isBinary= */ true);
  }
}



