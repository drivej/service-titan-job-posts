(function (blocks, blockEditor, components, element, i18n, serverSideRender) {
  const { registerBlockType } = blocks;
  const { InspectorControls, useBlockProps } = blockEditor;
  const { PanelBody, RangeControl, TextControl } = components;
  const { createElement: el, Fragment } = element;
  const { __ } = i18n;
  const ServerSideRender = serverSideRender;

  registerBlockType('st-sync/recent-jobs', {
    edit: function (props) {
      const blockProps = useBlockProps();
      const attributes = props.attributes;
      const setAttributes = props.setAttributes;

      return el(
        Fragment,
        null,
        el(
          InspectorControls,
          null,
          el(
            PanelBody,
            { title: __('Job query', 'service-titan-job-post') },
            el(TextControl, {
              label: __('Service slug', 'service-titan-job-post'),
              help: __('Optional on a nested service/location page.', 'service-titan-job-post'),
              value: attributes.serviceSlug,
              onChange: function (value) { setAttributes({ serviceSlug: value }); }
            }),
            el(TextControl, {
              label: __('Location slug', 'service-titan-job-post'),
              help: __('Optional on a nested service/location page.', 'service-titan-job-post'),
              value: attributes.locationSlug,
              onChange: function (value) { setAttributes({ locationSlug: value }); }
            }),
            el(RangeControl, {
              label: __('Jobs to show', 'service-titan-job-post'),
              help: __('Use 0 to inherit the global setting.', 'service-titan-job-post'),
              value: attributes.jobsToShow || 0,
              min: 0,
              max: 12,
              onChange: function (value) { setAttributes({ jobsToShow: value }); }
            }),
            el(TextControl, {
              label: __('Heading', 'service-titan-job-post'),
              value: attributes.heading,
              onChange: function (value) { setAttributes({ heading: value }); }
            })
          )
        ),
        el(
          'div',
          blockProps,
          el(ServerSideRender, {
            block: 'st-sync/recent-jobs',
            attributes: attributes
          })
        )
      );
    },
    save: function () {
      return null;
    }
  });
})(
  window.wp.blocks,
  window.wp.blockEditor,
  window.wp.components,
  window.wp.element,
  window.wp.i18n,
  window.wp.serverSideRender
);
