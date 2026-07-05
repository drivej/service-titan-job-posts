(function (blocks, blockEditor, element, serverSideRender) {
  const { registerBlockType } = blocks;
  const { useBlockProps } = blockEditor;
  const { createElement } = element;
  const ServerSideRender = serverSideRender;

  registerBlockType('st-sync/job-details', {
    edit: function () {
      const blockProps = useBlockProps();

      return createElement(
        'div',
        blockProps,
        createElement(ServerSideRender, {
          block: 'st-sync/job-details',
          attributes: {}
        })
      );
    },
    // Dynamic blocks are rendered by the PHP render callback.
    save: function () {
      return null;
    }
  });
})(window.wp.blocks, window.wp.blockEditor, window.wp.element, window.wp.serverSideRender);
