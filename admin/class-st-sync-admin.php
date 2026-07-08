<?php
/**
 * Subscription, connection, and content-policy administration.
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
        add_action('admin_post_st_sync_checkout', [$this, 'start_checkout']);
        add_action('admin_post_st_sync_activate', [$this, 'activate_site']);
        add_action('admin_post_st_sync_connect', [$this, 'connect_servicetitan']);
        add_action('admin_post_st_sync_refresh', [$this, 'refresh_status']);
        add_action('admin_post_st_sync_billing_portal', [$this, 'open_billing_portal']);
        add_action('admin_post_st_sync_deactivate', [$this, 'deactivate_site']);
        add_action('update_option_st_sync_options', [$this, 'sync_policy'], 10, 2);
    }

    public static function defaults(): array
    {
        return [
            'min_price'              => '0',
            'jobs_since'             => gmdate('Y-m-d', strtotime('-7 days')),
            'min_summary_words'      => '5',
            'completion_custom_field'=> '',
            'default_service_slug'   => '',
            'service_mappings'       => '',
            'allowed_cities'         => '',
            'excluded_job_types'     => '',
            'recent_jobs_count'      => '3',
        ];
    }

    public function add_plugin_admin_menu(): void
    {
        add_menu_page(
            __('ServiceTitan Local Jobs', 'service-titan-job-post'),
            __('Local Jobs Sync', 'service-titan-job-post'),
            'manage_options',
            'st-sync-settings',
            [$this, 'render_settings_page'],
            'dashicons-location-alt'
        );
    }

    public function register_st_settings(): void
    {
        register_setting('st_sync_group', 'st_sync_options', [
            'type'              => 'array',
            'sanitize_callback' => [$this, 'sanitize_options'],
            'default'           => self::defaults(),
        ]);

        add_settings_section(
            'st_filter_section',
            __('Content and filtering', 'service-titan-job-post'),
            '__return_false',
            'st-sync-settings'
        );
        $this->add_field('jobs_since', __('Initial backfill date', 'service-titan-job-post'), 'date');
        $this->add_field('min_price', __('Minimum job total ($)', 'service-titan-job-post'), 'number');
        $this->add_field('min_summary_words', __('Minimum completion-detail words', 'service-titan-job-post'), 'number');
        $this->add_field(
            'completion_custom_field',
            __('Completion custom field', 'service-titan-job-post'),
            'text',
            __('Optional ServiceTitan custom-field name or type ID used when Summary of Work is unavailable.', 'service-titan-job-post')
        );
        $this->add_field(
            'default_service_slug',
            __('Default service slug', 'service-titan-job-post'),
            'text',
            __('Optional fallback for single-trade sites. Leave blank to quarantine unclassified jobs.', 'service-titan-job-post')
        );
        $this->add_field(
            'service_mappings',
            __('Service mappings', 'service-titan-job-post'),
            'textarea',
            __('One per line, such as “123456=plumbing”. Stable Job Type IDs are preferred.', 'service-titan-job-post')
        );
        $this->add_field(
            'allowed_cities',
            __('Allowed cities', 'service-titan-job-post'),
            'textarea',
            __('Optional comma- or line-separated allowlist.', 'service-titan-job-post')
        );
        $this->add_field(
            'excluded_job_types',
            __('Excluded job types', 'service-titan-job-post'),
            'textarea',
            __('Optional comma- or line-separated exact Job Type names.', 'service-titan-job-post')
        );
        $this->add_field('recent_jobs_count', __('Jobs shown on location pages', 'service-titan-job-post'), 'number');
    }

    public function sanitize_options($input): array
    {
        $input = is_array($input) ? $input : [];

        return [
            'min_price'               => (string) max(0, (float) ($input['min_price'] ?? 0)),
            'jobs_since'              => $this->sanitize_date((string) ($input['jobs_since'] ?? '')),
            'min_summary_words'       => (string) min(100, max(1, (int) ($input['min_summary_words'] ?? 5))),
            'completion_custom_field' => sanitize_text_field((string) ($input['completion_custom_field'] ?? '')),
            'default_service_slug'    => sanitize_title((string) ($input['default_service_slug'] ?? '')),
            'service_mappings'        => sanitize_textarea_field((string) ($input['service_mappings'] ?? '')),
            'allowed_cities'          => sanitize_textarea_field((string) ($input['allowed_cities'] ?? '')),
            'excluded_job_types'      => sanitize_textarea_field((string) ($input['excluded_job_types'] ?? '')),
            'recent_jobs_count'       => (string) min(12, max(1, (int) ($input['recent_jobs_count'] ?? 3))),
        ];
    }

    public function render_field(array $args): void
    {
        $options = wp_parse_args(get_option('st_sync_options', []), self::defaults());
        $id = (string) $args['id'];
        $type = (string) $args['type'];
        $value = (string) ($options[$id] ?? '');
        $name = 'st_sync_options[' . esc_attr($id) . ']';

        if ('textarea' === $type) {
            echo '<textarea name="' . $name . '" class="large-text" rows="4">' . esc_textarea($value) . '</textarea>';
        } else {
            echo '<input type="' . esc_attr($type) . '" name="' . $name . '" value="' . esc_attr($value) . '" class="regular-text">';
        }

        if (! empty($args['description'])) {
            echo '<p class="description">' . esc_html($args['description']) . '</p>';
        }
    }

    public function render_settings_page(): void
    {
        if (! current_user_can('manage_options')) {
            return;
        }

        $client = new ST_Sync_Service_Client();
        $site = $client->site();
        $entitlement = is_array($site['entitlement'] ?? null) ? $site['entitlement'] : [];
        $connected = $client->is_connected();
        $notice = get_transient('st_sync_admin_notice_' . get_current_user_id());
        if ($notice) {
            delete_transient('st_sync_admin_notice_' . get_current_user_id());
        }
        ?>
        <div class="wrap">
            <h1><?php esc_html_e('ServiceTitan Local Job Content', 'service-titan-job-post'); ?></h1>

            <?php if (is_array($notice)) : ?>
                <div class="notice notice-<?php echo esc_attr($notice['type']); ?> is-dismissible">
                    <p><?php echo esc_html($notice['message']); ?></p>
                </div>
            <?php endif; ?>
            <?php if (get_option('st_sync_policy_dirty')) : ?>
                <div class="notice notice-warning"><p>
                    <?php esc_html_e('Content policy changes are saved locally but have not synced to the hosted worker yet. Save again after the hosted service is reachable.', 'service-titan-job-post'); ?>
                </p></div>
            <?php endif; ?>

            <?php if (! $client->is_configured()) : ?>
                <div class="notice notice-error"><p>
                    <?php esc_html_e('This build does not have a hosted service URL configured.', 'service-titan-job-post'); ?>
                </p></div>
            <?php elseif (! $connected) : ?>
                <h2><?php esc_html_e('Start subscription', 'service-titan-job-post'); ?></h2>
                <p><?php esc_html_e('Create a monthly or yearly subscription, then return with the issued license key to activate this site.', 'service-titan-job-post'); ?></p>
                <form action="<?php echo esc_url(admin_url('admin-post.php')); ?>" method="post">
                    <input type="hidden" name="action" value="st_sync_checkout">
                    <?php wp_nonce_field('st_sync_checkout'); ?>
                    <table class="form-table"><tbody>
                        <tr>
                            <th><label for="st-checkout-email"><?php esc_html_e('Billing email', 'service-titan-job-post'); ?></label></th>
                            <td><input id="st-checkout-email" type="email" name="billing_email" class="regular-text" value="<?php echo esc_attr((string) get_option('admin_email')); ?>" required></td>
                        </tr>
                        <tr>
                            <th><label for="st-checkout-plan"><?php esc_html_e('Plan', 'service-titan-job-post'); ?></label></th>
                            <td>
                                <select id="st-checkout-plan" name="plan">
                                    <option value="monthly"><?php esc_html_e('Monthly', 'service-titan-job-post'); ?></option>
                                    <option value="yearly"><?php esc_html_e('Yearly', 'service-titan-job-post'); ?></option>
                                </select>
                            </td>
                        </tr>
                    </tbody></table>
                    <?php submit_button(__('Start checkout', 'service-titan-job-post')); ?>
                </form>

                <h2><?php esc_html_e('Activate subscription', 'service-titan-job-post'); ?></h2>
                <p><?php esc_html_e('Activation is validated by the hosted service. Editing this plugin cannot make the hosted worker deliver jobs without an eligible subscription.', 'service-titan-job-post'); ?></p>
                <form action="<?php echo esc_url(admin_url('admin-post.php')); ?>" method="post">
                    <input type="hidden" name="action" value="st_sync_activate">
                    <?php wp_nonce_field('st_sync_activate'); ?>
                    <label for="st-license-key"><?php esc_html_e('License key', 'service-titan-job-post'); ?></label>
                    <input id="st-license-key" type="password" name="license_key" class="regular-text" required autocomplete="off">
                    <?php submit_button(__('Activate site', 'service-titan-job-post')); ?>
                </form>
            <?php else : ?>
                <?php $this->render_subscription_status($site, $entitlement); ?>
                <?php $this->render_connection_form(); ?>

                <form action="options.php" method="post">
                    <?php
                    settings_fields('st_sync_group');
                    do_settings_sections('st-sync-settings');
                    submit_button(__('Save content policy', 'service-titan-job-post'));
                    ?>
                </form>

                <h2><?php esc_html_e('Disconnect site', 'service-titan-job-post'); ?></h2>
                <p><?php esc_html_e('Disconnecting or canceling stops future deliveries. Existing WordPress job posts remain untouched.', 'service-titan-job-post'); ?></p>
                <form action="<?php echo esc_url(admin_url('admin-post.php')); ?>" method="post">
                    <input type="hidden" name="action" value="st_sync_deactivate">
                    <?php wp_nonce_field('st_sync_deactivate'); ?>
                    <?php submit_button(__('Disconnect site', 'service-titan-job-post'), 'secondary'); ?>
                </form>
            <?php endif; ?>
        </div>
        <?php
    }

    public function start_checkout(): void
    {
        $this->authorize_action('st_sync_checkout');
        $email = isset($_POST['billing_email']) ? sanitize_email(wp_unslash($_POST['billing_email'])) : '';
        $plan = isset($_POST['plan']) ? sanitize_key(wp_unslash($_POST['plan'])) : 'monthly';
        $result = (new ST_Sync_Service_Client())->checkout($email, $plan);
        if (is_wp_error($result)) {
            $this->redirect_with_result($result, '');
        }

        $checkout_url = esc_url_raw((string) ($result['checkout_url'] ?? ''));
        $scheme = (string) wp_parse_url($checkout_url, PHP_URL_SCHEME);
        $license_key = sanitize_text_field((string) ($result['license_key'] ?? ''));
        if ('https' !== $scheme || '' === $license_key) {
            $this->set_notice('error', __('The hosted service returned an invalid checkout response.', 'service-titan-job-post'));
            wp_safe_redirect(admin_url('admin.php?page=st-sync-settings'));
            exit;
        }

        $this->render_checkout_interstitial($license_key, $checkout_url);
    }

    public function activate_site(): void
    {
        $this->authorize_action('st_sync_activate');
        $license_key = isset($_POST['license_key']) ? trim((string) wp_unslash($_POST['license_key'])) : '';
        $result = (new ST_Sync_Service_Client())->activate($license_key);
        $this->redirect_with_result($result, __('Site activated.', 'service-titan-job-post'));
    }

    public function connect_servicetitan(): void
    {
        $this->authorize_action('st_sync_connect');
        $connection = [
            'environment'   => isset($_POST['environment']) ? sanitize_key(wp_unslash($_POST['environment'])) : 'production',
            'tenant_id'     => isset($_POST['tenant_id']) ? sanitize_text_field(wp_unslash($_POST['tenant_id'])) : '',
            'client_id'     => isset($_POST['client_id']) ? trim((string) wp_unslash($_POST['client_id'])) : '',
            'client_secret' => isset($_POST['client_secret']) ? trim((string) wp_unslash($_POST['client_secret'])) : '',
        ];
        $result = (new ST_Sync_Service_Client())->connect_servicetitan($connection);
        $this->redirect_with_result($result, __('ServiceTitan connection saved securely.', 'service-titan-job-post'));
    }

    public function refresh_status(): void
    {
        $this->authorize_action('st_sync_refresh');
        $result = (new ST_Sync_Service_Client())->status();
        $this->redirect_with_result($result, __('Subscription status refreshed.', 'service-titan-job-post'));
    }

    public function open_billing_portal(): void
    {
        $this->authorize_action('st_sync_billing_portal');
        $result = (new ST_Sync_Service_Client())->billing_portal();
        if (is_wp_error($result)) {
            $this->redirect_with_result($result, '');
        }

        $portal_url = esc_url_raw((string) ($result['portal_url'] ?? ''));
        $scheme = (string) wp_parse_url($portal_url, PHP_URL_SCHEME);
        if ('https' !== $scheme) {
            $this->set_notice('error', __('The hosted service returned an invalid billing portal URL.', 'service-titan-job-post'));
            wp_safe_redirect(admin_url('admin.php?page=st-sync-settings'));
            exit;
        }

        wp_redirect($portal_url);
        exit;
    }

    public function deactivate_site(): void
    {
        $this->authorize_action('st_sync_deactivate');
        $result = (new ST_Sync_Service_Client())->deactivate();
        $this->redirect_with_result($result, __('Site disconnected. Existing posts were preserved.', 'service-titan-job-post'));
    }

    public function sync_policy($old_value, $new_value): void
    {
        unset($old_value);
        $client = new ST_Sync_Service_Client();
        if (! $client->is_connected()) {
            return;
        }

        $result = $client->update_policy(is_array($new_value) ? $new_value : []);
        if (is_wp_error($result)) {
            update_option('st_sync_policy_dirty', time(), false);
            $this->set_notice('error', $result->get_error_message());
        } else {
            delete_option('st_sync_policy_dirty');
        }
    }

    private function render_subscription_status(array $site, array $entitlement): void
    {
        $eligible = ! empty($entitlement['eligible']);
        ?>
        <h2><?php esc_html_e('Subscription', 'service-titan-job-post'); ?></h2>
        <table class="widefat striped" style="max-width: 720px">
            <tbody>
                <tr><th><?php esc_html_e('Site ID', 'service-titan-job-post'); ?></th><td><?php echo esc_html((string) ($site['site_id'] ?? '')); ?></td></tr>
                <tr><th><?php esc_html_e('Entitlement', 'service-titan-job-post'); ?></th><td><?php echo esc_html($eligible ? __('Eligible', 'service-titan-job-post') : __('Not eligible', 'service-titan-job-post')); ?></td></tr>
                <tr><th><?php esc_html_e('Status', 'service-titan-job-post'); ?></th><td><?php echo esc_html((string) ($entitlement['status'] ?? 'unknown')); ?></td></tr>
                <tr><th><?php esc_html_e('Plan', 'service-titan-job-post'); ?></th><td><?php echo esc_html((string) ($entitlement['plan'] ?? '')); ?></td></tr>
                <tr><th><?php esc_html_e('Current period ends', 'service-titan-job-post'); ?></th><td><?php echo esc_html((string) ($entitlement['current_period_end'] ?? '')); ?></td></tr>
            </tbody>
        </table>
        <form action="<?php echo esc_url(admin_url('admin-post.php')); ?>" method="post">
            <input type="hidden" name="action" value="st_sync_refresh">
            <?php wp_nonce_field('st_sync_refresh'); ?>
            <?php submit_button(__('Refresh subscription status', 'service-titan-job-post'), 'secondary'); ?>
        </form>
        <form action="<?php echo esc_url(admin_url('admin-post.php')); ?>" method="post">
            <input type="hidden" name="action" value="st_sync_billing_portal">
            <?php wp_nonce_field('st_sync_billing_portal'); ?>
            <?php submit_button(__('Manage billing', 'service-titan-job-post'), 'secondary'); ?>
        </form>
        <?php
    }

    private function render_connection_form(): void
    {
        ?>
        <h2><?php esc_html_e('ServiceTitan connection', 'service-titan-job-post'); ?></h2>
        <p><?php esc_html_e('Credentials are sent over HTTPS to encrypted hosted storage and are not saved in WordPress.', 'service-titan-job-post'); ?></p>
        <form action="<?php echo esc_url(admin_url('admin-post.php')); ?>" method="post" autocomplete="off">
            <input type="hidden" name="action" value="st_sync_connect">
            <?php wp_nonce_field('st_sync_connect'); ?>
            <table class="form-table"><tbody>
                <tr>
                    <th><label for="st-environment"><?php esc_html_e('Environment', 'service-titan-job-post'); ?></label></th>
                    <td><select id="st-environment" name="environment"><option value="production"><?php esc_html_e('Production', 'service-titan-job-post'); ?></option><option value="integration"><?php esc_html_e('Integration', 'service-titan-job-post'); ?></option></select></td>
                </tr>
                <tr><th><label for="st-tenant-id"><?php esc_html_e('Tenant ID', 'service-titan-job-post'); ?></label></th><td><input id="st-tenant-id" name="tenant_id" class="regular-text" required></td></tr>
                <tr><th><label for="st-client-id"><?php esc_html_e('Client ID', 'service-titan-job-post'); ?></label></th><td><input id="st-client-id" name="client_id" class="regular-text" required autocomplete="off"></td></tr>
                <tr><th><label for="st-client-secret"><?php esc_html_e('Client secret', 'service-titan-job-post'); ?></label></th><td><input id="st-client-secret" type="password" name="client_secret" class="regular-text" required autocomplete="new-password"></td></tr>
            </tbody></table>
            <?php submit_button(__('Save ServiceTitan connection', 'service-titan-job-post')); ?>
        </form>
        <p class="description"><?php esc_html_e('Required scopes: Jobs (Read), Job Types (Read), and Locations (Read).', 'service-titan-job-post'); ?></p>
        <?php
    }

    private function add_field(string $id, string $title, string $type = 'text', string $description = ''): void
    {
        add_settings_field(
            $id,
            $title,
            [$this, 'render_field'],
            'st-sync-settings',
            'st_filter_section',
            ['id' => $id, 'type' => $type, 'description' => $description]
        );
    }

    private function sanitize_date(string $date): string
    {
        $parsed = DateTimeImmutable::createFromFormat('!Y-m-d', $date);
        return $parsed && $parsed->format('Y-m-d') === $date
            ? $date
            : self::defaults()['jobs_since'];
    }

    private function render_checkout_interstitial(string $license_key, string $checkout_url): void
    {
        require_once ABSPATH . 'wp-admin/admin-header.php';
        ?>
        <div class="wrap">
            <h1><?php esc_html_e('Continue to subscription checkout', 'service-titan-job-post'); ?></h1>
            <div class="notice notice-warning inline"><p>
                <?php esc_html_e('Copy this license key before continuing. The plugin does not store it in WordPress, and you will need it after checkout completes.', 'service-titan-job-post'); ?>
            </p></div>
            <p><label for="st-issued-license-key"><strong><?php esc_html_e('License key', 'service-titan-job-post'); ?></strong></label></p>
            <p><input id="st-issued-license-key" type="text" class="large-text code" readonly value="<?php echo esc_attr($license_key); ?>" onclick="this.select();"></p>
            <p>
                <a class="button button-primary button-hero" href="<?php echo esc_url($checkout_url); ?>">
                    <?php esc_html_e('Continue to secure checkout', 'service-titan-job-post'); ?>
                </a>
                <a class="button button-secondary" href="<?php echo esc_url(admin_url('admin.php?page=st-sync-settings')); ?>">
                    <?php esc_html_e('Back to plugin settings', 'service-titan-job-post'); ?>
                </a>
            </p>
            <p class="description">
                <?php esc_html_e('After the Stripe subscription is active, paste this license key into the activation form on this settings page.', 'service-titan-job-post'); ?>
            </p>
        </div>
        <?php
        require_once ABSPATH . 'wp-admin/admin-footer.php';
        exit;
    }

    private function authorize_action(string $action): void
    {
        if (! current_user_can('manage_options')) {
            wp_die(
                esc_html__('You are not allowed to manage this integration.', 'service-titan-job-post'),
                '',
                ['response' => 403]
            );
        }
        check_admin_referer($action);
    }

    private function redirect_with_result($result, string $success_message): void
    {
        if (is_wp_error($result)) {
            $this->set_notice('error', $result->get_error_message());
        } else {
            $this->set_notice('success', $success_message);
        }
        wp_safe_redirect(admin_url('admin.php?page=st-sync-settings'));
        exit;
    }

    private function set_notice(string $type, string $message): void
    {
        set_transient('st_sync_admin_notice_' . get_current_user_id(), [
            'type'    => in_array($type, ['success', 'error', 'warning', 'info'], true) ? $type : 'info',
            'message' => sanitize_text_field($message),
        ], MINUTE_IN_SECONDS);
    }
}
