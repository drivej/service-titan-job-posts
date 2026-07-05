<?php
    /**
 * Handles the ServiceTitan Sync admin settings page.
 */

    if (! defined('ABSPATH')) {
    exit;
    }

    class ST_Sync_Admin
    {

    public function __construct()
    {
        add_action('admin_menu', [$this, 'add_plugin_admin_menu']);
        add_action('admin_init', [$this, 'register_st_settings']);
    }

    /**
     * Add the menu to the WordPress sidebar
     */
    public function add_plugin_admin_menu()
    {
        add_menu_page(
            'ServiceTitan Sync',
            'ST Sync',
            'manage_options',
            'st-sync-settings',
            [$this, 'render_settings_page'],
            'dashicons-cloud'
        );
    }

    /**
     * Register sections and fields
     */
    public function register_st_settings()
    {
        register_setting('st_sync_group', 'st_sync_options');

        // Connection Section
        add_settings_section('st_conn_section', 'ServiceTitan API Connection', null, 'st-sync-settings');

        $this->add_st_field('tenant_id', 'Tenant ID', 'st_conn_section');
        $this->add_st_field('client_id', 'Client ID', 'st_conn_section');
        $this->add_st_field('client_secret', 'Client Secret', 'st_conn_section', 'password');

        // Filter Section
        add_settings_section('st_filter_section', 'Job Sync Filters', null, 'st-sync-settings');

        $this->add_st_field('min_price', 'Minimum Price ($)', 'st_filter_section', 'number');

        $this->add_st_field('jobs_since', 'Sync Jobs Since', 'st_filter_section', 'date');
    }

    /**
     * Helper to add fields quickly.
     *
     * @param string $id      The unique ID/slug for the setting.
     * @param string $title   The human-readable label for the field.
     * @param string $section The slug of the section this field belongs to.
     * @param string $type    The HTML input type (text, password, number).
     */
    private function add_st_field(string $id, string $title, string $section, string $type = 'text'): void
    {
        add_settings_field(
            $id,
            $title,
            [$this, 'render_field'],
            'st-sync-settings',
            $section,
            ['id' => $id, 'type' => $type]
        );
    }

    /**
     * Render HTML for the fields.
     *
     * @param array $args Data passed from add_settings_field, containing 'id' and 'type'.
     * @return void
     */
    public function render_field(array $args): void
    {
        $options = get_option('st_sync_options');

        // Retrieve the specific ID and Type from the $args array
        $id   = isset($args['id']) ? $args['id'] : '';
        $type = isset($args['type']) ? $args['type'] : 'text';

        // Get the saved value from the database
        $val = isset($options[$id]) ? esc_attr($options[$id]) : '';

        // Output the HTML
        echo "<input type='" . esc_attr($type) . "' name='st_sync_options[" . esc_attr($id) . "]' value='$val' class='regular-text'>";
    }

    /**
     * Render the actual settings page
     */
    /**
     * Render the actual settings page
     */
    public function render_settings_page(): void
    {
        ?>
    <div class="wrap">
        <h1>
            <span class="dashicons dashicons-cloud" style="font-size: 1em; vertical-align: middle;"></span>
            ServiceTitan Sync Configuration
        </h1>
        <hr />

        <div class="card" style="max-width: 100%; margin-top: 20px;">
            <p><strong>How to connect:</strong></p>
            <ol>
                <li>Log in to your <strong>ServiceTitan Developer Portal</strong>.</li>
                <li>Create a new application to get your <strong>Client ID</strong> and <strong>Secret</strong>.</li>
                <li>Ensure you have your <strong>Tenant ID</strong> from your account settings.</li>
            </ol>
        </div>

        <form action="options.php" method="post" style="margin-top: 20px;">
            <?php
                // Output security fields for the registered setting "st_sync_group"
                        settings_fields('st_sync_group');

                        // Output the sections and their fields
                        do_settings_sections('st-sync-settings');

                        // Standard WordPress save button
                        submit_button('Save & Sync Settings');
                    ?>
        </form>
    </div>

    <style>
        /* Small UI tweaks to make the form look better */
        .form-table th { width: 250px; font-weight: 600; }
        .regular-text { width: 100%; max-width: 400px; }
    </style>
    <?php
        }

        }

    // new ST_Sync_Admin();
