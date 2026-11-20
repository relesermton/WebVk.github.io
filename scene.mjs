/**
 * src/scene.mjs — a reusable WebVk scene: the rotating coloured triangle
 * used by both demo/ and playground/. Keeping it here means one place
 * owns the (slightly fiddly) Vulkan object setup and the double-buffer
 * rule that fixes blinking:
 *
 *   There is one framebuffer per swapchain image. vkQueuePresentKHR
 *   flips the image index, so the next frame MUST bind the framebuffer
 *   whose colour attachment is the *current* image. Binding a single
 *   fixed framebuffer while presenting alternates between a rendered
 *   image and an unrendered one — which looks like blinking.
 */

import {
  VkFormat, VkAttachmentLoadOp, VkAttachmentStoreOp, VkImageAspectFlag,
  VkImageUsageFlag, VkBufferUsageFlag, VkCoreTopology, VkCullModeFlag,
  VkFrontFace, VkCompareOp, VkBlendFactor, VkBlendOp, VkColorComponentFlag,
  VkShaderStageFlag, VkBuiltinShader,
} from './webvk.js';

export class TriangleScene {
  /** @param {import('./webvk.js').WebVk} wv */
  constructor(wv, { width = 128, height = 128 } = {}) {
    this.wv = wv;
    this.width = width;
    this.height = height;

    const device = this.device = wv.vkCreateDevice(
      wv.vkCreateInstance(),
    );
    this.queue = wv.vkGetDeviceQueue(device, 0, 0);

    const surface = this.surface = wv.vkCreateSurfaceKHR(width, height);
    this.swapchain = wv.vkCreateSwapchainKHR(device, {
      surface,
      imageExtent: { width, height },
      minImageCount: 2,
    });
    this.images = wv.vkGetSwapchainImagesKHR(this.swapchain, 8);

    // one colour view + one framebuffer *per image* (the blink fix)
    this.colorViews = this.images.map((image) => wv.vkCreateImageView(device, {
      image, format: VkFormat.R8G8B8A8_UNORM, aspectMask: VkImageAspectFlag.COLOR,
    }));

    // a single depth attachment can be shared by every framebuffer: each
    // render pass clears it before use
    const depthImage = this.depthImage = wv.vkCreateImage(device, {
      width, height, format: VkFormat.D32_SFLOAT,
      usage: VkImageUsageFlag.DEPTH_STENCIL_ATTACHMENT,
    });
    const depthMemory = wv.vkAllocateMemory(device, width * height * 4, { hostVisible: 0 });
    wv.vkBindImageMemory(depthImage, depthMemory, 0);
    const depthView = wv.vkCreateImageView(device, {
      image: depthImage, format: VkFormat.D32_SFLOAT, aspectMask: VkImageAspectFlag.DEPTH,
    });

    this.renderPass = wv.vkCreateRenderPass(device, {
      pAttachments: [
        { format: VkFormat.R8G8B8A8_UNORM, loadOp: VkAttachmentLoadOp.CLEAR,
          storeOp: VkAttachmentStoreOp.STORE, finalLayout: 0 },
        { format: VkFormat.D32_SFLOAT, loadOp: VkAttachmentLoadOp.CLEAR,
          storeOp: VkAttachmentStoreOp.STORE, finalLayout: 0 },
      ],
      pSubpasses: [{
        colorAttachmentCount: 1, pColorAttachments: [0], pDepthStencilAttachment: 1,
      }],
    });
    this.framebuffers = this.colorViews.map((view) => wv.vkCreateFramebuffer(device, {
      renderPass: this.renderPass, width, height, pAttachments: [view, depthView],
    }));
    this.depthView = depthView;

    const vs = this.vs = wv.vkCreateShaderModule(device, {
      stage: VkShaderStageFlag.VERTEX, builtin: VkBuiltinShader.VERTEX_COLOR_VS,
    });
    const fs = this.fs = wv.vkCreateShaderModule(device, {
      stage: VkShaderStageFlag.FRAGMENT, builtin: VkBuiltinShader.INTERPOLATED_FS,
    });
    this.layout = wv.vkCreatePipelineLayout(device, { pushConstantSize: 64 });

    // staging: vertices at +0, everything else the API needs transiently
    this.staging = wv.vkAllocateMemory(device, 8192, { hostVisible: 1 });
    this.stagingPtr = wv.vkMapMemory(this.staging);

    this.colors = [[1, 0.2, 0.2, 1], [0.2, 1, 0.2, 1], [0.3, 0.4, 1, 1]];
    this.positions = [[-0.8, -0.8, 0.5], [0.8, -0.8, 0.5], [0, 0.8, 0.5]];
    this.vbuf = wv.vkCreateBuffer(device, 3 * 7 * 4, VkBufferUsageFlag.VERTEX_BUFFER);
    wv.vkBindBufferMemory(this.vbuf, this.staging, 0);
    this.vbPtr = wv.vkGetBufferHostPtr(this.vbuf);
    this._uploadVertices();

    this.pool = wv.vkCreateCommandPool(device);
    [this.cb] = wv.vkAllocateCommandBuffers({
      commandPool: this.pool, commandBufferCount: 1,
    });
    this.fence = wv.vkCreateFence(device);

    // mutable draw state (the playground changes these live)
    this.options = {
      cullMode: VkCullModeFlag.BACK,
      depthTest: true,
      blend: true,
      scaleX: 0.5,
      speed: 1,
    };
    this.pipeline = null;
    this._rebuildPipeline();
  }

  _uploadVertices() {
    const m = this.wv.mem;
    let i = 0;
    for (let v = 0; v < 3; v++) {
      for (const x of this.positions[v]) m.writeF32(this.vbPtr + i++ * 4, x);
      for (const x of this.colors[v]) m.writeF32(this.vbPtr + i++ * 4, x);
    }
  }

  _rebuildPipeline() {
    const wv = this.wv;
    if (this.pipeline) wv.vkDestroyPipeline(this.pipeline);
    const o = this.options;
    this.pipeline = wv.vkCreateGraphicsPipeline(this.device, {
      vertexShader: this.vs, fragmentShader: this.fs, layout: this.layout,
      topology: VkCoreTopology.TRIANGLE_LIST,
      cullMode: o.cullMode, frontFace: VkFrontFace.COUNTER_CLOCKWISE,
      depthTestEnable: o.depthTest, depthWriteEnable: o.depthTest,
      depthCompareOp: VkCompareOp.LESS,
      blendEnable: o.blend,
      srcColorBlendFactor: VkBlendFactor.ONE,
      dstColorBlendFactor: VkBlendFactor.DST_COLOR,
      colorBlendOp: VkBlendOp.ADD,
      colorWriteMask: VkColorComponentFlag.RGBA,
      pVertexInputState: {
        bindingDescriptions: [{ binding: 0, stride: 28 }],
        attributeDescriptions: [
          { location: 0, format: VkFormat.R32G32B32_SFLOAT, offset: 0, binding: 0 },
          { location: 1, format: VkFormat.R32G32B32A32_SFLOAT, offset: 12, binding: 0 },
        ],
      },
    });
  }

  /** apply partial option changes; rebuild the pipeline only when needed */
  setOptions(patch) {
    const rebuild = ['cullMode', 'depthTest', 'blend'].some(
      (k) => k in patch && patch[k] !== this.options[k],
    );
    Object.assign(this.options, patch);
    if (patch.colors) {
      this.colors = patch.colors;
      this._uploadVertices();
    }
    if (rebuild) this._rebuildPipeline();
  }

  /** column-major MVP: rotate about Z, squeeze X by scaleX */
  buildMvp(t) {
    const a = t * 0.9 * this.options.speed;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const sx = this.options.scaleX;
    return [
      c * sx, s * sx, 0, 0,
      -s, c, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ];
  }

  /** the index of the image we must render into right now */
  get currentIndex() {
    return this.wv.vkGetSwapchainImageIndex(this.swapchain, this.images);
  }

  /** record + submit one frame into the current swapchain image */
  render(t, clear = [0.06, 0.09, 0.14, 1]) {
    const wv = this.wv;
    const idx = this.currentIndex;
    if (idx < 0) throw new Error('current swapchain image not found');
    const fb = this.framebuffers[idx];

    wv.vkResetCommandBuffer(this.cb);
    wv.vkBeginCommandBuffer(this.cb);
    wv.vkCmdBeginRenderPass(this.cb, {
      framebuffer: fb,
      renderPass: this.renderPass,
      pClearValues: [{ float32: clear }],
    });
    wv.vkCmdSetViewport(this.cb, {
      x: 0, y: 0, width: this.width, height: this.height,
      minDepth: 0, maxDepth: 1,
    });
    wv.vkCmdSetScissor(this.cb, {
      x: 0, y: 0, width: this.width, height: this.height,
    });
    wv.vkCmdBindPipeline(this.cb, this.pipeline);
    wv.vkCmdBindVertexBuffers(this.cb, this.vbuf);
    wv.vkCmdPushConstants(this.cb, this.layout, VkShaderStageFlag.ALL_GRAPHICS,
      this.buildMvp(t));
    wv.vkCmdDraw(this.cb, 3);
    wv.vkCmdEndRenderPass(this.cb);
    wv.vkEndCommandBuffer(this.cb);

    wv.vkQueueSubmit(this.queue, { pCommandBuffers: [this.cb] }, this.fence);
    return idx;
  }

  /** blit the rendered image, then flip the swapchain index */
  present(viewport) {
    viewport.present(this.queue, this.swapchain);
  }

  stats() { return this.wv.vkGetStats(); }
}
